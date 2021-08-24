#!/bin/sh
cp ./*.json /tmp/ && rm -rf ./.git ./.github ./* && git clone https://github.com/moo-the-cow/belaUI . && mv /tmp/*.json ./
