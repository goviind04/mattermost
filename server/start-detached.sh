#!/bin/bash
cd /home/ubuntu/mattermost/server
nohup go run -buildvcs=false -ldflags "-X \"github.com/mattermost/mattermost/server/public/model.BuildNumber=dev\" -X \"github.com/mattermost/mattermost/server/public/model.BuildDate=n/a\" -X \"github.com/mattermost/mattermost/server/public/model.BuildHash=$(git rev-parse HEAD)\" -X \"github.com/mattermost/mattermost/server/public/model.BuildHashEnterprise=none\" -X \"github.com/mattermost/mattermost/server/public/model.BuildEnterpriseReady=false\"" -tags sourceavailable ./cmd/mattermost > mattermost.log 2>&1 < /dev/null &
echo $! > mattermost.pid
echo "Server started with PID $(cat mattermost.pid)"
