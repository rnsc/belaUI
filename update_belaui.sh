#!/bin/sh
cp ../belaUI/*.json /tmp/ && rm -rf ../belaUI/.git ../belaUI/.github ../belaUI/* && git clone https://github.com/moo-the-cow/belaUI . && mv /tmp/*.json ./
