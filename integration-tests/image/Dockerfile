# syntax=docker/dockerfile:1
FROM adguard/core-libs:2.6

# Install the required utilities
RUN apt update --allow-releaseinfo-change && \
    apt install -y build-essential cmake curl git gnupg lsb-release iperf3 iproute2 \
    net-tools software-properties-common wget nano iputils-ping iptables tcpdump jq && \
    apt clean && \
    rm -rf /var/lib/apt/lists/*

# Install gocurl
RUN go install github.com/ameshkov/gocurl@latest

# Download Chrome
COPY package.json /puppeteer/
RUN cd /puppeteer && yarn install && [ -e /root/.cache/puppeteer/chrome ] && rm -rf /puppeteer
