from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd


DATABASE_PATH = Path(__file__).resolve().parent / "hospital_data.db"
BASE_COLUMNS = [
    "id",
    "hospital_name",
    "source_file",
    "upload_date",
    "upload_hash",
    "dataset_id",
    "record_hash",
]


def _normalize_header_name(value):
    if value is None:
        return ""
    text = str(value).strip()
    text = re.sub(r"[_/\\-]+", " ", text)
    text = re.sub(r"\s+", " ", text)
    return text


def _canonicalize_column_name(value):
    text = _normalize_header_name(value)
    if not text:
        return ""
    key = re.sub(r"[^a-z0-9]+", " ", text.casefold()).strip()
    aliases = {
        "service name": "Service Name",
        "service name ": "Service Name",
        "servicename": "Service Name",
        "service name": "Service Name",
        "service type": "Service Type",
        "servicetype": "Service Type",
        "period": "Period",
        "admission date": "DOA",
        "admissiondate": "DOA",
        "date of admission": "DOA",
        "doa": "DOA",
        "discharge date": "DOD",
        "dischargedate": "DOD",
        "date of discharge": "DOD",
        "dod": "DOD",
        "month": "Month",
        "dept name": "Dept. Name",
        "department": "Dept. Name",
        "department name": "Dept. Name",
        "dept": "Dept. Name",
        "doctor name": "Doctor Name",
        "doctor": "Doctor Name",
        "panel name": "Panel Name",
        "panel": "Panel Name",
        "type": "Type",
        "record type": "Type",
        "service final amount": "Service Final Amount",
        "service final amounts": "Service Final Amount",
        "service amount": "Service Amount",
        "cash due": "Cash Due",
        "cash due amount": "Cash Due",
        "credit due": "Credit Due",
        "credit due amount": "Credit Due",
        "bed days": "Bed Days",
        "bed days count": "Bed Days",
        "beddays": "Bed Days",
        "uhid": "UHID",
        "uhid number": "UHID",
        "patient id": "UHID",
    }
    return aliases.get(key, text)


def _quote_identifier(identifier):
    return '"' + str(identifier).replace('"', '""') + '"'


@contextmanager
def _connect():
    connection = sqlite3.connect(DATABASE_PATH, timeout=30)
    connection.row_factory = sqlite3.Row
    try:
        connection.execute("PRAGMA busy_timeout = 30000")
        yield connection
    finally:
        connection.close()


def init_database():
    DATABASE_PATH.parent.mkdir(parents=True, exist_ok=True)
    with _connect() as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS hospital_data (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                hospital_name TEXT NOT NULL,
                source_file TEXT NOT NULL,
                upload_date TIMESTAMP NOT NULL,
                upload_hash TEXT NOT NULL,
                dataset_id TEXT,
                record_hash TEXT NOT NULL UNIQUE
            )
            """
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_hospital_data_hospital "
            "ON hospital_data (hospital_name)"
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_hospital_data_upload "
            "ON hospital_data (upload_hash)"
        )
        existing_columns = _existing_columns(connection)
        if "dataset_id" not in {column.casefold() for column in existing_columns}:
            connection.execute(
                "ALTER TABLE hospital_data ADD COLUMN dataset_id TEXT"
            )
        legacy_rows = connection.execute(
            """
            SELECT id, hospital_name, source_file, upload_hash, dataset_id
            FROM hospital_data
            WHERE dataset_id IS NULL OR dataset_id = ''
            """
        ).fetchall()
        for row in legacy_rows:
            legacy_key = "|".join(
                [row["hospital_name"], row["source_file"], row["upload_hash"]]
            )
            legacy_id = "legacy-" + hashlib.sha256(
                legacy_key.encode("utf-8")
            ).hexdigest()
            connection.execute(
                "UPDATE hospital_data SET dataset_id = ? WHERE id = ?",
                (legacy_id, row["id"]),
            )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_hospital_data_dataset_id "
            "ON hospital_data (dataset_id, id)"
        )
        connection.execute("DROP INDEX IF EXISTS idx_hospital_data_dataset")
        connection.commit()


def _existing_columns(connection):
    return [
        row[1]
        for row in connection.execute("PRAGMA table_info(hospital_data)").fetchall()
    ]


def _prepare_frame(frame, existing_columns):
    reserved = {column.casefold() for column in BASE_COLUMNS}
    existing_by_key = {column.casefold(): column for column in existing_columns}
    columns = []
    positions = []
    used = set()

    for position, value in enumerate(frame.columns):
        name = _canonicalize_column_name(value)
        if not name or name.casefold() in reserved:
            continue
        normalized_name = _normalize_header_name(name)
        existing_match = existing_by_key.get(normalized_name.casefold(), normalized_name)
        candidate = existing_match
        suffix = 2
        while candidate.casefold() in used:
            candidate = f"{existing_match}_{suffix}"
            suffix += 1
        used.add(candidate.casefold())
        positions.append(position)
        columns.append(candidate)

    prepared = frame.iloc[:, positions].copy()
    prepared.columns = columns
    return prepared


def _ensure_columns(connection, columns, existing_columns):
    existing = {column.casefold() for column in existing_columns}
    for column in columns:
        if column.casefold() in existing:
            continue
        connection.execute(
            f"ALTER TABLE hospital_data ADD COLUMN {_quote_identifier(column)} TEXT"
        )
        existing.add(column.casefold())


def _normalise_for_hash(value):
    if pd.isna(value):
        return ""
    if isinstance(value, pd.Timestamp):
        return value.isoformat()
    return str(value)


def _record_hash(row, columns, hospital_name, upload_hash, row_number):
    values = {
        column: _normalise_for_hash(row.get(column))
        for column in columns
    }
    values["hospital_name"] = hospital_name
    values["upload_hash"] = upload_hash
    values["row_number"] = row_number
    payload = json.dumps(values, sort_keys=True, ensure_ascii=True)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _upload_hash(file_bytes):
    return hashlib.sha256(file_bytes).hexdigest()


def check_duplicate_upload(file_bytes, hospital_name):
    init_database()
    upload_hash = _upload_hash(file_bytes)
    with _connect() as connection:
        row = connection.execute(
            """
            SELECT COUNT(*) AS count
            FROM hospital_data
            WHERE hospital_name = ? AND upload_hash = ?
            """,
            (hospital_name, upload_hash),
        ).fetchone()
    return bool(row["count"])


def save_hospital_data(df, hospital_name, source_file, file_bytes):
    if df is None or df.empty:
        raise ValueError("The uploaded Excel file is empty.")

    init_database()
    upload_hash = _upload_hash(file_bytes)
    upload_date = datetime.now(timezone.utc).isoformat()

    with _connect() as connection:
        existing_dataset = connection.execute(
            """
            SELECT dataset_id
            FROM hospital_data
            WHERE hospital_name = ? AND upload_hash = ?
            LIMIT 1
            """,
            (hospital_name, upload_hash),
        ).fetchone()
        dataset_id = (
            existing_dataset["dataset_id"]
            if existing_dataset and existing_dataset["dataset_id"]
            else str(uuid.uuid4())
        )
        existing_columns = _existing_columns(connection)
        frame = _prepare_frame(df.copy(), existing_columns)
        if frame.empty or not len(frame.columns):
            raise ValueError("The uploaded file has no usable data columns.")
        frame = frame.where(pd.notna(frame), None)
        columns = list(frame.columns)
        _ensure_columns(connection, columns, existing_columns)

        existing_count = connection.execute(
            "SELECT COUNT(*) AS count FROM hospital_data WHERE dataset_id = ?",
            (dataset_id,),
        ).fetchone()["count"]
        if existing_dataset and existing_count != len(frame):
            connection.execute(
                "DELETE FROM hospital_data WHERE dataset_id = ?",
                (dataset_id,),
            )

        records = []
        for row_number, (_, row) in enumerate(frame.iterrows()):
            values = {
                column: _normalise_for_hash(row[column])
                if row[column] is not None else None
                for column in columns
            }
            values["record_hash"] = _record_hash(
                row, columns, hospital_name, upload_hash, row_number
            )
            records.append(values)

        table_columns = BASE_COLUMNS + columns
        quoted_columns = ", ".join(_quote_identifier(column) for column in table_columns)
        placeholders = ", ".join("?" for _ in table_columns)
        sql = (
            f"INSERT OR IGNORE INTO hospital_data ({quoted_columns}) "
            f"VALUES ({placeholders})"
        )
        row_values = (
            [
                None,
                hospital_name,
                source_file,
                upload_date,
                upload_hash,
                dataset_id,
                record["record_hash"],
            ] + [record.get(column) for column in columns]
            for record in records
        )
        cursor = connection.executemany(sql, row_values)
        inserted = cursor.rowcount
        connection.commit()

    return {
        "inserted": inserted,
        "total": len(records),
        "duplicate": inserted == 0,
        "upload_hash": upload_hash,
        "dataset_id": dataset_id,
    }


def latest_hospital():
    init_database()
    with _connect() as connection:
        row = connection.execute(
            """
            SELECT hospital_name
            FROM hospital_data
            ORDER BY upload_date DESC, id DESC
            LIMIT 1
            """
        ).fetchone()
    return row["hospital_name"] if row else None


def list_saved_datasets():
    init_database()
    with _connect() as connection:
        rows = connection.execute(
            """
              SELECT dataset_id, source_file, hospital_name, upload_hash,
                   COUNT(*) AS record_count, MAX(upload_date) AS upload_date
            FROM hospital_data
              GROUP BY dataset_id, source_file, hospital_name, upload_hash
            ORDER BY MAX(id) DESC
            """
        ).fetchall()
    return [dict(row) for row in rows]


def load_hospital_data(
    hospital_name=None, source_file=None, upload_hash=None, dataset_id=None
):
    init_database()
    with _connect() as connection:
        existing_columns = _existing_columns(connection)
        reserved = {column.casefold() for column in BASE_COLUMNS}
        data_columns = [
            column for column in existing_columns
            if column.casefold() not in reserved
        ]
        conditions = []
        parameters = []
        if hospital_name is not None:
            conditions.append("hospital_name = ?")
            parameters.append(hospital_name)
        if source_file is not None:
            conditions.append("source_file = ?")
            parameters.append(source_file)
        if upload_hash is not None:
            conditions.append("upload_hash = ?")
            parameters.append(upload_hash)
        if dataset_id is not None:
            conditions.append("dataset_id = ?")
            parameters.append(dataset_id)
        where = f" WHERE {' AND '.join(conditions)}" if conditions else ""
        if not data_columns:
            return pd.DataFrame()
        columns = ", ".join(_quote_identifier(column) for column in data_columns)
        frame = pd.read_sql_query(
            f"SELECT {columns} FROM hospital_data{where} ORDER BY id",
            connection,
            params=parameters,
        )
    if frame.empty:
        return pd.DataFrame()
    return frame


def load_all_hospital_data():
    """Load every saved record while retaining its stored hospital and source."""
    init_database()
    with _connect() as connection:
        existing_columns = _existing_columns(connection)
        internal = {
            "id", "upload_date", "upload_hash", "dataset_id", "record_hash",
        }
        selected_columns = [
            column for column in existing_columns
            if column.casefold() not in internal
        ]
        if not selected_columns:
            return pd.DataFrame()
        columns = ", ".join(_quote_identifier(column) for column in selected_columns)
        frame = pd.read_sql_query(
            f"SELECT {columns} FROM hospital_data ORDER BY id", connection
        )
    if frame.empty:
        return pd.DataFrame()
    return frame


def load_comparison_date_data():
    """Load only the columns needed to infer comparison years and months."""
    init_database()
    with _connect() as connection:
        existing = {column.casefold(): column for column in _existing_columns(connection)}
        type_column = existing.get("type")
        doa_column = existing.get("doa")
        dod_column = existing.get("dod")
        if not type_column or not (doa_column or dod_column):
            return pd.DataFrame(columns=["Type", "DOA", "DOD"])
        type_sql = _quote_identifier(type_column)
        doa_sql = _quote_identifier(doa_column) if doa_column else "NULL"
        dod_sql = _quote_identifier(dod_column) if dod_column else "NULL"
        rows = connection.execute(
            f"""
            SELECT DISTINCT CASE
                WHEN lower(trim({type_sql})) IN ('admission', 'opd')
                    THEN substr(CAST({doa_sql} AS TEXT), 1, 10)
                WHEN lower(trim({type_sql})) = 'discharge'
                    THEN substr(CAST({dod_sql} AS TEXT), 1, 10)
            END AS event_date
            FROM hospital_data
            WHERE lower(trim({type_sql})) IN ('admission', 'opd', 'discharge')
            """
        ).fetchall()
    dates = [row["event_date"] for row in rows if row["event_date"]]
    return pd.DataFrame({
        "Type": ["Admission"] * len(dates),
        "DOA": dates,
        "DOD": [None] * len(dates),
    })


def delete_dataset(dataset_id):
    if not dataset_id:
        raise ValueError("A dataset ID is required.")
    init_database()
    with _connect() as connection:
        cursor = connection.execute(
            "DELETE FROM hospital_data WHERE dataset_id = ?",
            (dataset_id,),
        )
        connection.commit()
    return cursor.rowcount


def export_hospital_data(destination, hospital_name=None, file_format="xlsx"):
    frame = load_hospital_data(hospital_name)
    destination = Path(destination)
    if file_format.casefold() == "csv":
        frame.to_csv(destination, index=False)
    else:
        frame.to_excel(destination, index=False)
    return destination
