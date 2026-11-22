#!/usr/bin/env bash
# Creates (or updates) everything in Azure for Right Services Photos. Run it in Azure Cloud Shell (Bash),
# signed in as an owner of the subscription. It is safe to run again: it only adds what is missing.
#
#   bash infra/go-live.sh you@example.com [second@example.com]
#
# What it does:
#   1. Creates the resource group "rsb-photos" in East US 2.
#   2. Makes random passwords (nobody sees them) and keeps them in Key Vault.
#   3. Deploys infra/main.bicep: API server, database, photo storage, website, spending alert.
#   4. Sets up a GitHub "deploy" identity with no stored password (OpenID Connect), limited to this
#      resource group, so the GitHub "Deploy" button can publish new versions.
# It prints the values to copy into GitHub at the end. It costs money from step 3 on (about $30-40/month).
set -euo pipefail

RG="${RSB_RESOURCE_GROUP:-rsb-photos}"
LOCATION="${RSB_LOCATION:-eastus2}"
REPO="${RSB_GITHUB_REPO:-brentsanford106-ship-it/Right-Services-Brain}"
BRANCH="${RSB_DEPLOY_BRANCH:-main}"
[ $# -ge 1 ] || { echo "Usage: bash infra/go-live.sh alert-email [another-email]"; exit 1; }
EMAILS=$(printf '"%s",' "$@"); EMAILS="[${EMAILS%,}]"

echo "== Subscription: $(az account show --query name -o tsv)"
read -r -p "Create/update Right Services Photos in resource group '$RG' ($LOCATION)? This starts monthly charges. Type yes: " ok
[ "$ok" = "yes" ] || { echo "Stopped. Nothing was created."; exit 1; }

az group create -n "$RG" -l "$LOCATION" -o none
ME=$(az ad signed-in-user show --query id -o tsv)

# Reuse the database admin password if this ran before; otherwise make a new random one.
VAULT=$(az keyvault list -g "$RG" --query "[0].name" -o tsv 2>/dev/null || true)
ADMIN_PW=""
if [ -n "$VAULT" ]; then ADMIN_PW=$(az keyvault secret show --vault-name "$VAULT" -n postgres-admin-password --query value -o tsv 2>/dev/null || true); fi
[ -n "$ADMIN_PW" ] || ADMIN_PW=$(openssl rand -hex 24)

echo "== Deploying (5-15 minutes)..."
OUT=$(az deployment group create -g "$RG" -n main --template-file "$(dirname "$0")/main.bicep" \
  --parameters alertEmails="$EMAILS" deployerObjectId="$ME" postgresAdminPassword="$ADMIN_PW" \
  ${OIDC_ISSUER:+oidcIssuer="$OIDC_ISSUER"} ${OIDC_AUDIENCE:+oidcAudience="$OIDC_AUDIENCE"} ${OIDC_JWKS_URI:+oidcJwksUri="$OIDC_JWKS_URI"} \
  --query properties.outputs -o json)
get() { echo "$OUT" | python3 -c "import json,sys; print(json.load(sys.stdin)['$1']['value'])"; }
VAULT=$(get vaultName); PGHOST=$(get postgresHost); API=$(get apiName)

echo "== Storing passwords in Key Vault $VAULT"
sleep 30 # new Key Vault permissions take a moment to apply
secret() { az keyvault secret show --vault-name "$VAULT" -n "$1" --query value -o tsv 2>/dev/null || true; }
[ -n "$(secret postgres-admin-password)" ] || az keyvault secret set --vault-name "$VAULT" -n postgres-admin-password --value "$ADMIN_PW" -o none
APP_PW=$(secret app-db-password); [ -n "$APP_PW" ] || { APP_PW=$(openssl rand -hex 24); az keyvault secret set --vault-name "$VAULT" -n app-db-password --value "$APP_PW" -o none; }
az keyvault secret set --vault-name "$VAULT" -n database-admin-url -o none \
  --value "postgres://rsbadmin:${ADMIN_PW}@${PGHOST}:5432/rsb?sslmode=verify-full"
az keyvault secret set --vault-name "$VAULT" -n database-url -o none \
  --value "postgres://rsb_app_login:${APP_PW}@${PGHOST}:5432/rsb?sslmode=verify-full"

echo "== GitHub deploy identity (no password; only this repository's $BRANCH branch may use it)"
APP_ID=$(az ad app list --display-name rsb-github-deploy --query "[0].appId" -o tsv)
if [ -z "$APP_ID" ]; then
  APP_ID=$(az ad app create --display-name rsb-github-deploy --query appId -o tsv)
  az ad sp create --id "$APP_ID" -o none
  az ad app federated-credential create --id "$APP_ID" --parameters "{\"name\":\"github-$BRANCH\",\"issuer\":\"https://token.actions.githubusercontent.com\",\"subject\":\"repo:$REPO:environment:production\",\"audiences\":[\"api://AzureADTokenExchange\"]}" -o none
fi
SP=$(az ad sp show --id "$APP_ID" --query id -o tsv)
RG_ID=$(az group show -n "$RG" --query id -o tsv)
az role assignment create --assignee-object-id "$SP" --assignee-principal-type ServicePrincipal --role Contributor --scope "$RG_ID" -o none 2>/dev/null || true
az role assignment create --assignee-object-id "$SP" --assignee-principal-type ServicePrincipal --role "Key Vault Secrets User" \
  --scope "$(az keyvault show -n "$VAULT" --query id -o tsv)" -o none 2>/dev/null || true

cat <<EOF

== Done. Copy these into GitHub: repository Settings > Environments > "production" > Variables (they are not secrets):
AZURE_CLIENT_ID        $APP_ID
AZURE_TENANT_ID        $(az account show --query tenantId -o tsv)
AZURE_SUBSCRIPTION_ID  $(az account show --query id -o tsv)
AZURE_RESOURCE_GROUP   $RG
AZURE_API_APP          $API
AZURE_KEY_VAULT        $VAULT
AZURE_POSTGRES_SERVER  $(get postgresName)
AZURE_WEBSITE          $(get websiteName)
API_URL                $(get apiUrl)

Website address: $(get websiteUrl)
Then run the "Deploy" workflow in GitHub (Actions tab).
EOF
