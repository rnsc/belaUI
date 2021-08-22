#!/bin/bash

set +ex

sed "s#WorkingDirectory=.*#WorkingDirectory=$(pwd)#g" belaUI.service > /etc/systemd/system/belaUI.service
systemctl daemon-reload
systemctl restart belaUI
systemctl enable belaUI
