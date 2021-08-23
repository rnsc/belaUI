#!/bin/sh
sed "s#WorkingDirectory=.*#WorkingDirectory=$(pwd)#g" belaUI.service > /etc/systemd/system/belaUI@.service &&
systemctl daemon-reload &&
systemctl restart belaUI@$1.service &&
systemctl enable belaUI@$1.service
