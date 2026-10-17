# Hospital Dashboard

A local dashboard for hospital reporting, comparison, and prediction.

## Run locally on Windows

Requires Python 3.13.

```powershell
py -3.13 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python server.py
```

Open <http://127.0.0.1:8010> in your browser. The application creates
`hospital_data.db` locally the first time it starts.

## Keep hospital data private

This application can store patient-identifying information and uploaded
hospital reports in its local database. Do not commit the database, source
spreadsheets, CSV files, generated reports, or downloaded interactive HTML
exports. The `.gitignore` excludes common local data files, but review every
file before publishing because ignore rules cannot protect files already
tracked by Git.

The dashboard is intended for local use. Do not expose it to the public
internet or use it with real patient data on a public hosting service without
appropriate authentication, access controls, and privacy review.
