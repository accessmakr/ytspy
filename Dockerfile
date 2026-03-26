FROM ghcr.io/imputnet/cobalt:latest

ENV API_URL="https://cobalt-render-private.onrender.com"
ENV CORS_WILDCARD="1"

EXPOSE 9000
