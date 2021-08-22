#!/bin/sh
cp ~/belaUI/*.json /tmp/ && \
sudo systemctl stop belaUI && \
rm -rf ~/belaUI && \
git clone https://github.com/rnsc/belaUI && \
mv /tmp/*.json ~/belaUI/ \
&& sudo systemctl start belaUI
