#!/bin/sh
cp ~/belaUI/*.json /tmp/ && systemctl stop belaUI && rm -rf ~/belaUI && git clone https://github.com/moo-the-cow/belaUI && mv /tmp/*.json ~/belaUI/ && systemctl start belaUI