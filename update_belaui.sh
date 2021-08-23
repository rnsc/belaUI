#!/bin/sh
cp ../belaUI/*.json /tmp/ && systemctl stop belaUI && rm -rf ../belaUI && cd .. && git clone https://github.com/moo-the-cow/belaUI && mv /tmp/*.json ./belaUI/ && chown $1 -R ./belaUI && systemctl start belaUI
