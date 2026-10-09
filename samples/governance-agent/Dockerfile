# Use the official Python 3.11 slim image
FROM python:3.11-slim

# Set working directory
WORKDIR /app

# Install system dependencies required for compilation and git operations
RUN apt-get update && apt-get install -y \
    build-essential \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# Copy hashed dependencies and install with --require-hashes
COPY requirements.txt ./
RUN pip install --no-cache-dir --require-hashes -r requirements.txt

# Copy project metadata, source code, and resources
COPY pyproject.toml README.md ./
COPY metadata_propagation/ ./metadata_propagation/
COPY glossary_terms.json knowledge_insights.json ./
COPY unstructured_docs/ ./unstructured_docs/

# Cloud Run defaults: listens on port 8080 (passed via PORT env var)
ENV PORT=8080
ENV HOST=0.0.0.0
ENV PYTHONUNBUFFERED=1
ENV PYTHONPATH=/app

EXPOSE 8080

# Launch the Gradio app via module entrypoint
CMD ["python3", "-m", "metadata_propagation.ui.gradio_app"]