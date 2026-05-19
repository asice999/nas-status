FROM python:3.12-alpine

RUN apk add --no-cache docker-cli

WORKDIR /app
COPY agent.py /app/agent.py

CMD ["sh", "-c", "while true; do python /app/agent.py; sleep 60; done"]
