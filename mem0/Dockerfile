FROM mem0/mem0-api-server:latest

RUN pip install --no-cache-dir "psycopg[pool]" psycopg2-binary "mem0ai[graph]" && \
    mkdir -p /app/history

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
