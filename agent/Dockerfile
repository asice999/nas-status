FROM python:3.12-alpine

RUN apk add --no-cache docker-cli iputils curl

WORKDIR /app
COPY agent.py /app/agent.py
COPY config.example.json /app/config.json

CMD ["python", "/app/agent.py"]
