#!/bin/sh
cp ~/belaUI/*.json /tmp/ && \
systemctl stop belaUI && \
rm -rf ~/belaUI && \
git clone https://github.com/rnsc/belaUI && \
mv /tmp/*.json ~/belaUI/ \
&& systemctl start belaUI
