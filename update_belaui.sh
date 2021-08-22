#!/bin/bash

set +ex

sudo systemctl stop belaUI

cd ~/belaUI/ || exit

echo "*.json" > .gitignore

git pull

sudo systemctl start belaUI
