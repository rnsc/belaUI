#!/bin/sh
cp ../belaUI/*.json /tmp/ && rm -rf ../belaUI && git clone https://github.com/moo-the-cow/belaUI ../belaUI && mv /tmp/*.json ../belaUI/
