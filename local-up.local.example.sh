# Machine-specific settings for local-up.sh and the applet.
#
# Copy this file to local-up.local.sh next to your local-up.sh link (the folder that holds the
# repos) and keep only the lines you need. That copy is yours: it is never committed, and
# updating stack-launcher never touches it. Run `./local-up.sh --help` to see each service's
# port and where it came from.
#
# Ports normally need no setting here: backend ports are read from each repo's own .env
# (e.g. NUCLEUS_PORT), falling back to the app's built-in default, so they match what the app
# really listens on. Set one here only when that is not the port you want the kit to use.

# A service on another port (the Vite UIs are started with this port too)
# SERVICE_PORT[client]=5180
# SERVICE_PORT[nucleus]=5200

# A repo cloned under another folder name (relative to the folder that holds the repos)
# SERVICE_DIR[form-builder-api]=form-builder-backend

# Infra on another port, or under another systemd unit name
# INFRA_PORT[kafka]=29092
# INFRA_UNIT[kafka]=confluent-kafka

# Infra run in Docker: started with `docker start <container>`, no sudo prompt
# INFRA_UNIT[kafka]=docker:kafka

# Mongo as a replica set (form-builder needs one): runs
# `mongod --replSet $MONGO_REPLSET --dbpath $MONGO_DBPATH --fork` instead of the systemd mongod,
# initiates the set on first use, and offers to stop the systemd mongod when it holds the port
# INFRA_UNIT[mongo]=replset
# MONGO_REPLSET=rs0
# MONGO_DBPATH=/data/db

# Dev tunnel for `./local-up.sh --tunnel` and the applet's tunnel row (`devtunnel list` shows the ID)
# TUNNEL_ID=my-tunnel-id.inc1

# Services unticked in the checklist until you pick them once (replaces the whole list)
# DEFAULT_OFF=(payment-manager agrisphere-api auditor catalyst agrisphere-ui)

# IPv6 is disabled by default (one sudo prompt per boot) because the Node services need it.
# Keep it that way; set this only if you are sure your Node services work with IPv6 on.
# DISABLE_IPV6=false

# Bigger changes (a new service, another command) can redefine a whole array, copied from
# local-up.sh with its closing ")" on its own line:
# SERVICES=(
#   "name|repo-folder|PORT_KEY:default|/url-path|infra,needed|command"
# )

# "Push to client" deploys origin branches to this remote (only repos that have it); main is
# deployed as CLIENT_MAIN_BRANCH there
# CLIENT_REMOTE=client
# CLIENT_MAIN_BRANCH=client-main
