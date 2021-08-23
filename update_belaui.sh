#!/bin/sh
sudo cp ../belaUI/*.json /tmp/ && sudo rm /tmp/version.json && sudo systemctl stop belaUI && sudo rm -rf ../belaUI && cd .. && git clone https://github.com/moo-the-cow/belaUI && sudo mv /tmp/*.json ./belaUI/ && sudo chown $USER -R ./belaUI && sudo systemctl start belaUI
