#!/bin/sh
cp ../belaUI/*.json /tmp/ && rm -rf ../belaUI && cd .. && git clone https://github.com/moo-the-cow/belaUI && mv /tmp/*.json ./belaUI/
