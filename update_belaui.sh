#!/bin/sh
cp ../belaUI/*.json /tmp/ && sudo systemctl stop belaUI && rm -rf ../belaUI && cd .. && git clone https://github.com/moo-the-cow/belaUI && mv /tmp/*.json ./belaUI/ && sudo systemctl start belaUI
