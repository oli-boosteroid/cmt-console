# CMT Console - standalone service (Railway). Flask + Mongo only, no bot deps.
FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY console_app.py .
COPY public_app.py .
COPY api/ ./api/
COPY services/ ./services/
COPY utils/ ./utils/
COPY web/ ./web/
COPY fb-extension/ ./fb-extension/

# Railway injects $PORT; console_app reads it (default 8080 for local runs).
EXPOSE 8080
CMD ["python", "console_app.py"]
