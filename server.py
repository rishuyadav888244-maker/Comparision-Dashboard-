from __future__ import annotations

import json
import logging
import mimetypes
import os
import re
import threading
import traceback
from email import policy
from email.parser import BytesParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pandas as pd

import backend
import database
import dashboard_service
import prediction_service


ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
MAX_UPLOAD_BYTES = 25 * 1024 * 1024
MAX_REQUEST_BYTES = 80 * 1024 * 1024
logger = logging.getLogger("hospital_dashboard")


class DashboardHandler(BaseHTTPRequestHandler):
    server_version = "HospitalDashboard/1.0"

    def do_GET(self):
        request = urlparse(self.path)
        try:
            if request.path == "/api/health":
                self._json_response({"status": "ok"})
            elif request.path == "/api/options":
                self._json_response(dashboard_service.dashboard_options())
            elif request.path == "/api/uploads":
                parameters = self._query_dict(request.query)
                hospital_name = (
                    parameters.get("hospitalName")
                    or parameters.get("hospital")
                )
                self._json_response({
                    "uploads": dashboard_service.list_report_uploads(hospital_name)
                })
            elif request.path == "/api/comparison/options":
                self._json_response(dashboard_service.comparison_options())
            elif request.path == "/api/dashboard":
                self._json_response(
                    dashboard_service.get_dashboard(self._query_dict(request.query))
                )
            elif request.path == "/api/comparison":
                parameters = self._query_dict(request.query)
                filters = json.loads(parameters.pop("filters", "{}"))
                parameters["filters"] = filters
                self._json_response(dashboard_service.get_comparison(parameters))
            elif request.path == "/api/prediction":
                parameters = self._query_dict(request.query)
                parameters["filters"] = json.loads(parameters.pop("filters", "{}"))
                self._json_response(prediction_service.get_prediction(parameters))
            elif request.path == "/api/comparison/export.csv":
                parameters = self._query_dict(request.query)
                filters = json.loads(parameters.pop("filters", "{}"))
                parameters["filters"] = filters
                content = dashboard_service.export_comparison_csv(parameters)
                filename = "hospital_comparison_report.csv"
                self.send_response(200)
                self.send_header("Content-Type", "text/csv; charset=utf-8")
                self.send_header(
                    "Content-Disposition",
                    f'attachment; filename="{filename}"',
                )
                self.send_header("Content-Length", str(len(content)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(content)
            elif request.path == "/api/export.csv":
                self._export_csv(self._query_dict(request.query))
            elif request.path == "/api/export/interactive.html":
                content = dashboard_service.export_interactive_html()
                filename = "Vedansh_Medicare_Interactive_Dashboard.html"
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header(
                    "Content-Disposition",
                    f'attachment; filename="{filename}"',
                )
                self.send_header("Content-Length", str(len(content)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(content)
            elif request.path == "/" or request.path == "/dashboard":
                self._static_response("dashboard.html")
            elif request.path.startswith("/assets/"):
                relative_path = request.path.removeprefix("/assets/")
                self._static_response(relative_path)
            else:
                self._json_response({"error": "Not found."}, status=404)
        except (ValueError, KeyError, TypeError, json.JSONDecodeError) as error:
            self._json_response({"error": str(error)}, status=400)
        except Exception as error:
            logger.error("GET %s failed: %s\n%s", request.path, error, traceback.format_exc())
            self._json_response(
                {"error": "The dashboard request failed. Check the server log for details."},
                status=500,
            )

    def do_POST(self):
        request = urlparse(self.path)
        try:
            if request.path == "/api/upload":
                files, fields = self._multipart_files()
                result = dashboard_service.upload_files(
                    files,
                    hospital_name=fields.get("hospitalName"),
                )
                database.init_database()
                self._json_response({"success": True, "upload": result}, status=201)
            elif request.path == "/api/datasets/delete":
                payload = self._json_body()
                deleted = database.delete_dataset(payload.get("datasetId"))
                self._json_response({"success": True, "deletedRows": deleted})
            elif request.path == "/api/uploads/delete":
                payload = self._json_body()
                result = dashboard_service.delete_report_upload(
                    payload.get("uploadId")
                )
                self._json_response({"success": True, "result": result})
            elif request.path == "/api/uploads/include":
                payload = self._json_body()
                result = dashboard_service.set_report_upload_included(
                    payload.get("uploadId"),
                    payload.get("included"),
                )
                self._json_response({"success": True, "result": result})
            else:
                self._json_response({"error": "Not found."}, status=404)
        except (ValueError, KeyError, TypeError, json.JSONDecodeError) as error:
            self._json_response({"error": str(error)}, status=400)
        except Exception as error:
            logger.error("POST %s failed: %s\n%s", request.path, error, traceback.format_exc())
            self._json_response(
                {"error": "The dashboard request failed. Check the server log for details."},
                status=500,
            )

    def _query_dict(self, query):
        parameters = parse_qs(query, keep_blank_values=True)
        return {
            key: values if key in {"month", "period"} else values[-1]
            for key, values in parameters.items()
        }

    def _json_body(self):
        length = self._content_length()
        if length > MAX_REQUEST_BYTES:
            raise ValueError("The request is too large.")
        payload = self.rfile.read(length)
        return json.loads(payload.decode("utf-8"))

    def _multipart_files(self):
        length = self._content_length()
        if length > MAX_REQUEST_BYTES:
            raise ValueError("The upload request exceeds the 80 MB request limit.")
        content_type = self.headers.get("Content-Type", "")
        if "multipart/form-data" not in content_type:
            raise ValueError("Upload must use a multipart form.")
        body = self.rfile.read(length)
        message = BytesParser(policy=policy.default).parsebytes(
            f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode("ascii")
            + body
        )
        files = []
        fields = {}
        for part in message.iter_parts():
            field_name = part.get_param("name", header="content-disposition")
            if field_name == "file":
                filename = part.get_filename()
                if not filename:
                    raise ValueError("Each uploaded report must have a file name.")
                file_bytes = part.get_payload(decode=True) or b""
                if len(file_bytes) > MAX_UPLOAD_BYTES:
                    raise ValueError("Each report must be no larger than 25 MB.")
                safe_name = re.sub(r"[\r\n]", "", Path(filename).name)
                files.append((safe_name, file_bytes))
            elif field_name:
                payload = part.get_payload(decode=True) or b""
                charset = part.get_content_charset() or "utf-8"
                fields[field_name] = payload.decode(charset).strip()
        if not files:
            raise ValueError("Choose at least one report to upload.")
        return files, fields

    def _multipart_file(self):
        files, _ = self._multipart_files()
        return files[0]

    def _content_length(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as error:
            raise ValueError("Invalid request size.") from error
        if length < 0:
            raise ValueError("Invalid request size.")
        return length

    def _export_csv(self, query):
        hospital_name = query.get("hospital")
        dataset_id = query.get("datasetId", "")
        if hospital_name:
            datasets = [
                item for item in database.list_saved_datasets()
                if item["hospital_name"] == hospital_name
            ]
            if not datasets:
                raise ValueError("The selected hospital is not available.")
            frame = database.load_hospital_data(hospital_name=hospital_name)
            export_name = hospital_name
        else:
            if not dataset_id:
                raise ValueError("Choose a dataset before exporting.")
            dataset = next(
                (
                    item for item in database.list_saved_datasets()
                    if item["dataset_id"] == dataset_id
                ),
                None,
            )
            if dataset is None:
                raise ValueError("The selected dataset is not available.")
            frame = database.load_hospital_data(dataset_id=dataset_id)
            export_name = Path(dataset["source_file"]).stem
        months = query.get("month", "")
        periods = query.get("period", "")
        month_filter = (
            [part for item in months for part in item.split(",") if part]
            if isinstance(months, list) else [item for item in months.split(",") if item]
        )
        period_filter = (
            [part for item in periods for part in item.split(",") if part]
            if isinstance(periods, list) else [item for item in periods.split(",") if item]
        )
        cleaned = backend.clean_data(frame)
        filtered = backend.apply_filters(
            cleaned, month=month_filter, period=period_filter
        )
        start_date = query.get("startDate")
        end_date = query.get("endDate")
        if bool(start_date) != bool(end_date):
            raise ValueError("Both range start and end dates are required.")
        if start_date:
            filtered = backend.filter_comparison_range(
                filtered, start_date, end_date
            )
        content = filtered.to_csv(index=False).encode("utf-8-sig")
        filename = re.sub(
            r"[^A-Za-z0-9._ -]+",
            "_",
            export_name + "_dashboard_export.csv",
        )
        self.send_response(200)
        self.send_header("Content-Type", "text/csv; charset=utf-8")
        self.send_header(
            "Content-Disposition",
            f'attachment; filename="{filename}"',
        )
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(content)

    def _static_response(self, relative_path):
        static_path = (STATIC / relative_path).resolve()
        if not static_path.is_relative_to(STATIC.resolve()) or not static_path.is_file():
            self._json_response({"error": "Not found."}, status=404)
            return
        content = static_path.read_bytes()
        content_type = mimetypes.guess_type(static_path.name)[0] or "application/octet-stream"
        if content_type.startswith("text/") or content_type in {
            "application/javascript",
            "application/json",
        }:
            content_type += "; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(content)

    def _json_response(self, payload, status=200):
        content = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(content)

    def log_message(self, format_string, *args):
        logger.info("%s - %s", self.address_string(), format_string % args)


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    database.init_database()
    # Load and clean the data in the background so the first page opens quickly.
    threading.Thread(target=dashboard_service.warm_up, daemon=True).start()
    host = "127.0.0.1"
    port = int(os.environ.get("DASHBOARD_PORT", "8010"))
    httpd = ThreadingHTTPServer((host, port), DashboardHandler)
    print(f"Hospital executive dashboard running at http://{host}:{port}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping dashboard server.")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()