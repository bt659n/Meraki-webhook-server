FROM python:3.11-slim

WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application files
COPY app.py .
COPY templates/ ./templates/
COPY static/ ./static/

# Create directory for persistent SQLite data
RUN mkdir -p /data

# Configure environment variables
ENV DB_PATH=/data/webhooks.db
ENV PORT=8000

# Expose port
EXPOSE 8000

# Run the app
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
