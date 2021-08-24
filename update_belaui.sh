#!/bin/bash

set -e

sudo systemctl stop belaUI

cd ~/belaUI/ || exit

mv setup.json setup.json.orig

git pull

mv setup.json.orig setup.json

sudo systemctl start belaUI
