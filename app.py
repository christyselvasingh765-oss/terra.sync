import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory
from werkzeug.utils import secure_filename

# --------------------------------------------------
# SiteGuard AI - Flask Backend
# --------------------------------------------------

BASE_DIR = Path(__file__).resolve().parent
UPLOAD_DIR = BASE_DIR / "uploads"
DATABASE = BASE_DIR / "siteguard.db"

UPLOAD_DIR.mkdir(exist_ok=True)

app = Flask(__name__, static_folder=None)

# Allow up to 5 MB file + a little multipart overhead
app.config["MAX_CONTENT_LENGTH"] = 6 * 1024 * 1024

MAX_FILE_SIZE = 5 * 1024 * 1024

ALLOWED_TYPES = {
    "jpg": "image",
    "jpeg": "image",
    "png": "image",
    "webp": "image",
    "mp4": "video",
    "webm": "video",
    "mov": "video",
}

SEVERE_WORDS = (
    "fire", "burn", "collapse", "unconscious",
    "injury", "injured", "emergency", "fall"
)


# --------------------------------------------------
# Database
# --------------------------------------------------

def get_db():
    connection = sqlite3.connect(DATABASE, timeout=10)
    connection.row_factory = sqlite3.Row
    return connection


def init_db():
    with get_db() as db:
        db.execute("""
            CREATE TABLE IF NOT EXISTS incidents (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                worker_id TEXT NOT NULL,
                location TEXT NOT NULL,
                incident TEXT NOT NULL,
                reported_at TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'Open',
                evidence_filename TEXT
            )
        """)


def row_to_dict(row):
    return {
        "id": row["id"],
        "worker_id": row["worker_id"],
        "location": row["location"],
        "incident": row["incident"],
        "reported_at": row["reported_at"],
        "status": row["status"],
        "evidence_filename": row["evidence_filename"],
    }


def get_incidents():
    with get_db() as db:
        rows = db.execute("""
            SELECT * FROM incidents
            ORDER BY id DESC
        """).fetchall()

    return [row_to_dict(row) for row in rows]


def calculate_risk(incidents):
    """
    Demo risk score from unresolved incidents.
    This is not a validated safety assessment or AI model.
    """
    open_items = [
        item for item in incidents
        if item["status"].lower() == "open"
    ]

    score = 0

    for item in open_items:
        text = item["incident"].lower()

        if any(word in text for word in SEVERE_WORDS):
            score += 25
        else:
            score += 10

    score = min(score, 100)

    if score >= 70:
        level = "High"
    elif score >= 30:
        level = "Medium"
    else:
        level = "Low"

    return score, level


# Initialize database when the app starts
init_db()


# --------------------------------------------------
# Frontend pages and files
# --------------------------------------------------

@app.route("/")
def home():
    return send_from_directory(BASE_DIR, "index.html")


@app.route("/index.html")
def index_page():
    return send_from_directory(BASE_DIR, "index.html")


@app.route("/<path:filename>")
def frontend_files(filename):
    # Only serve known frontend files from the project root.
    allowed_files = {
        "style.css",
        "script.js",
        "manifest.json",
        "sw.js",
    }

    if filename not in allowed_files:
        return jsonify({"error": "File not found"}), 404

    return send_from_directory(BASE_DIR, filename)


# --------------------------------------------------
# API: Health check
# --------------------------------------------------

@app.route("/api/health", methods=["GET"])
def health_check():
    try:
        with get_db() as db:
            db.execute("SELECT 1").fetchone()

        return jsonify({
            "status": "ok",
            "service": "SiteGuard AI",
            "database": "connected",
            "timestamp": datetime.now(timezone.utc).isoformat()
        }), 200

    except sqlite3.Error:
        app.logger.exception("Database health check failed")
        return jsonify({
            "status": "error",
            "database": "unavailable"
        }), 500


# --------------------------------------------------
# API: Dashboard data
# --------------------------------------------------

@app.route("/api/dashboard", methods=["GET"])
def dashboard():
    incidents = get_incidents()

    open_items = [
        item for item in incidents
        if item["status"].lower() == "open"
    ]

    worker_ids = {
        item["worker_id"]
        for item in incidents
        if item["worker_id"]
    }

    risk_score, risk_level = calculate_risk(incidents)

    return jsonify({
        "workers": len(worker_ids),
        "open_incidents": len(open_items),
        "open_incident_count": len(open_items),
        "risk_score": risk_score,
        "risk_level": risk_level,
        "incident_history": incidents,
        "incidents": incidents
    }), 200


# --------------------------------------------------
# API: Incident history
# --------------------------------------------------

@app.route("/api/incidents", methods=["GET"])
def incident_history():
    return jsonify({
        "incidents": get_incidents()
    }), 200


# --------------------------------------------------
# API: Emergency SOS report
# --------------------------------------------------

@app.route("/api/emergency", methods=["POST"])
def create_emergency():
    worker_id = request.form.get("worker_id", "").strip()
    location = request.form.get("location", "").strip()
    incident_text = request.form.get("incident", "").strip()

    if not worker_id or not location or not incident_text:
        return jsonify({
            "success": False,
            "error": "Worker ID, location and incident details are required."
        }), 400

    if len(worker_id) > 80 or len(location) > 300:
        return jsonify({
            "success": False,
            "error": "Worker ID or location is too long."
        }), 400

    if len(incident_text) > 2000:
        return jsonify({
            "success": False,
            "error": "Incident details must be 2000 characters or less."
        }), 400

    uploaded_file = request.files.get("photo")
    saved_filename = None

    if uploaded_file and uploaded_file.filename:
        original_name = secure_filename(uploaded_file.filename)

        if not original_name or "." not in original_name:
            return jsonify({
                "success": False,
                "error": "Invalid upload filename."
            }), 400

        extension = original_name.rsplit(".", 1)[1].lower()

        if extension not in ALLOWED_TYPES:
            return jsonify({
                "success": False,
                "error": "Unsupported file. Use JPG, PNG, WEBP, MP4, WEBM or MOV."
            }), 400

        # Read at most 5 MB + 1 byte to enforce the file size limit.
        file_data = uploaded_file.stream.read(MAX_FILE_SIZE + 1)

        if len(file_data) > MAX_FILE_SIZE:
            return jsonify({
                "success": False,
                "error": "File size must be 5 MB or less."
            }), 413

        # Check the declared MIME type when the browser supplies one.
        declared_mime = (uploaded_file.mimetype or "").lower()
        expected_group = ALLOWED_TYPES[extension]

        if declared_mime:
            if not declared_mime.startswith(expected_group + "/"):
                return jsonify({
                    "success": False,
                    "error": "File extension and content type do not match."
                }), 400

        # Unique server-generated filename; never trust the original path.
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S%f")
        saved_filename = f"{timestamp}_{os.urandom(6).hex()}.{extension}"
        destination = UPLOAD_DIR / saved_filename

        try:
            with open(destination, "xb") as file_out:
                file_out.write(file_data)
        except OSError:
            app.logger.exception("Evidence file could not be saved")
            return jsonify({
                "success": False,
                "error": "Could not save the uploaded file."
            }), 500

    reported_at = datetime.now(timezone.utc).isoformat()

    try:
        with get_db() as db:
            cursor = db.execute("""
                INSERT INTO incidents (
                    worker_id, location, incident,
                    reported_at, status, evidence_filename
                )
                VALUES (?, ?, ?, ?, 'Open', ?)
            """, (
                worker_id,
                location,
                incident_text,
                reported_at,
                saved_filename
            ))

            incident_id = cursor.lastrowid

    except sqlite3.Error:
        app.logger.exception("Incident could not be saved")

        if saved_filename:
            try:
                (UPLOAD_DIR / saved_filename).unlink(missing_ok=True)
            except OSError:
                pass

        return jsonify({
            "success": False,
            "error": "Could not save the incident to the database."
        }), 500

    return jsonify({
        "success": True,
        "message": "SOS report saved successfully.",
        "id": incident_id,
        "status": "Open",
        "ambulance_notified": False,
        "note": (
            "This prototype records the report only. "
            "It does not automatically contact an ambulance or emergency service."
        )
    }), 201


# --------------------------------------------------
# API: Resolve an incident
# --------------------------------------------------

@app.route("/api/incidents/<int:incident_id>/resolve", methods=["PATCH"])
def resolve_incident(incident_id):
    try:
        with get_db() as db:
            cursor = db.execute("""
                UPDATE incidents
                SET status = 'Resolved'
                WHERE id = ? AND status = 'Open'
            """, (incident_id,))

            if cursor.rowcount == 0:
                row = db.execute(
                    "SELECT status FROM incidents WHERE id = ?",
                    (incident_id,)
                ).fetchone()

                if row is None:
                    return jsonify({
                        "success": False,
                        "error": "Incident not found."
                    }), 404

                return jsonify({
                    "success": False,
                    "error": "Incident is already resolved."
                }), 409

    except sqlite3.Error:
        app.logger.exception("Incident could not be resolved")
        return jsonify({
            "success": False,
            "error": "Could not update incident status."
        }), 500

    return jsonify({
        "success": True,
        "id": incident_id,
        "status": "Resolved",
        "message": "Incident marked as resolved."
    }), 200


# --------------------------------------------------
# Error handling
# --------------------------------------------------

@app.errorhandler(413)
def file_too_large(error):
    return jsonify({
        "success": False,
        "error": "Request is too large. Upload a file of 5 MB or less."
    }), 413


@app.errorhandler(404)
def not_found(error):
    if request.path.startswith("/api/"):
        return jsonify({"error": "API route not found"}), 404

    return jsonify({"error": "Page not found"}), 404


# --------------------------------------------------
# Run the development server
# --------------------------------------------------

if __name__ == "__main__":
    # Local development only; use a production server when deployed.
    app.run(host="127.0.0.1", port=5000, debug=False)
