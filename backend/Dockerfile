# THC-VMS backend — multi-stage production image.
# Build: docker build -f backend/Dockerfile -t thc-be:prod ./backend
# Migrations are embedded via //go:embed, so no SQL files are copied.
FROM golang:1.26-alpine AS builder
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . ./
RUN CGO_ENABLED=0 go build -trimpath -o /out/server ./cmd/server \
  && CGO_ENABLED=0 go build -trimpath -o /out/migrate ./cmd/migrate \
  && CGO_ENABLED=0 go build -trimpath -o /out/backfill-notifications ./cmd/backfill-notifications \
  && CGO_ENABLED=0 go build -trimpath -o /out/seeds ./seeds

FROM alpine:3.21
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app
COPY --from=builder /out/server /out/migrate /out/backfill-notifications /out/seeds ./
USER app
EXPOSE 8080
# Shell form: `${APP_PORT:-8080}` hanya diekspansi oleh shell saat runtime;
# pada exec form Docker tidak melakukan substitusi dan URL jadi literal.
HEALTHCHECK --interval=15s --timeout=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${APP_PORT:-8080}/api/v1/health" > /dev/null || exit 1
CMD ["./server"]
