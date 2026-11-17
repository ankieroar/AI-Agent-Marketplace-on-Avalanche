FROM mirror.gcr.io/library/ubuntu:24.04
RUN apt-get update -qq && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY icm-relayer /usr/local/bin/icm-relayer
ENTRYPOINT ["/usr/local/bin/icm-relayer"]

