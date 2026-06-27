#!/bin/bash

# =============================================================================
# github.sh - Reusable Interactive GitHub Git Helper
# Supports: pull, push, status, config
# Authentication: GitHub Personal Access Token (PAT) via remote URL
# =============================================================================

set -euo pipefail

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# --- Config File ---
CONFIG_FILE=".github-config"

# --- Helper Functions ---
info()    { echo -e "${CYAN}[INFO]${NC} $*"; }
success() { echo -e "${GREEN}[OK]${NC} $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*" >&2; }

# Load config from .github-config if present
load_config() {
    if [[ -f "$CONFIG_FILE" ]]; then
        # shellcheck source=/dev/null
        source "$CONFIG_FILE"
    fi
}

# Load environment variables (env takes precedence over config file)
load_env() {
    if [[ -n "${GITHUB_TOKEN:-}" ]];  then GIT_TOKEN="$GITHUB_TOKEN"; fi
    if [[ -n "${GIT_USER_NAME:-}" ]];  then GIT_NAME="$GIT_USER_NAME"; fi
    if [[ -n "${GIT_USER_EMAIL:-}" ]]; then GIT_EMAIL="$GIT_USER_EMAIL"; fi
    if [[ -n "${REMOTE_URL:-}" ]];     then GIT_REMOTE_URL="$REMOTE_URL"; fi
}

# Extract PAT from existing remote URL (https://<token>@github.com/...)
extract_token_from_remote() {
    local remote_url
    remote_url=$(git remote get-url origin 2>/dev/null || true)
    if [[ "$remote_url" =~ https://([^@]+)@github\.com ]]; then
        echo "${BASH_REMATCH[1]}"
    fi
}

# Get the clean remote URL (without token)
get_clean_remote_url() {
    local remote_url
    remote_url=$(git remote get-url origin 2>/dev/null || true)
    echo "$remote_url" | sed -E 's|https://[^@]+@|https://|'
}

# Ensure token is set; if not, try extracting from remote or prompt
ensure_token() {
    if [[ -z "${GIT_TOKEN:-}" ]]; then
        GIT_TOKEN=$(extract_token_from_remote)
    fi
    if [[ -z "$GIT_TOKEN" ]]; then
        read -rsp "GitHub PAT: " GIT_TOKEN
        echo
        if [[ -z "$GIT_TOKEN" ]]; then
            error "Token is required. Aborting."
            exit 1
        fi
    fi
}

# Get current branch name
get_branch() {
    local branch
    branch=$(git branch --show-current 2>/dev/null)
    if [[ -z "$branch" ]]; then
        error "Not on any branch or detached HEAD."
        exit 1
    fi
    echo "$branch"
}

# Validate we are inside a git repo
require_git_repo() {
    if ! git rev-parse --is-inside-work-tree &>/dev/null; then
        error "Not inside a git repository."
        exit 1
    fi
}

# Set remote URL with embedded token
set_remote_with_token() {
    local clean_url="$1"
    local token="$2"
    local authed_url
    authed_url=$(echo "$clean_url" | sed "s|https://|https://${token}@|")
    git remote set-url origin "$authed_url"
}

# --- Commands ---

cmd_status() {
    require_git_repo
    local branch
    branch=$(get_branch)

    echo -e "\n${CYAN}=== Branch ===${NC}"
    echo "  $branch"

    echo -e "\n${CYAN}=== Status ===${NC}"
    git status --short

    echo -e "\n${CYAN}=== Last 5 Commits ===${NC}"
    git log --oneline -5 2>/dev/null || warn "No commits yet."

    echo -e "\n${CYAN}=== Remote ===${NC}"
    git remote -v 2>/dev/null | head -2 || warn "No remote configured."
}

cmd_pull() {
    require_git_repo
    ensure_token

    local branch
    branch=$(get_branch)
    local clean_url
    clean_url=$(get_clean_remote_url)

    info "Pulling from origin/$branch ..."
    set_remote_with_token "$clean_url" "$GIT_TOKEN"

    if git pull origin "$branch"; then
        success "Pull completed."
    else
        error "Pull failed. Check your network and remote access."
        exit 1
    fi
}

cmd_push() {
    require_git_repo
    ensure_token

    local branch
    branch=$(get_branch)
    local clean_url
    clean_url=$(get_clean_remote_url)

    # Stage all changes
    info "Staging all changes (git add -A) ..."
    git add -A

    # Check if there are changes to commit
    if git diff --cached --quiet; then
        warn "No changes to commit."
    else
        # Determine commit message
        local msg="${COMMIT_MSG:-}"
        if [[ -z "$msg" ]]; then
            msg="[auto] commit - $(date '+%Y-%m-%d %H:%M:%S')"
        fi
        info "Committing: $msg"
        if git commit -m "$msg"; then
            success "Committed."
        else
            error "Commit failed."
            exit 1
        fi
    fi

    # Push
    info "Pushing to origin/$branch ..."
    set_remote_with_token "$clean_url" "$GIT_TOKEN"

    if git push origin "$branch"; then
        success "Push completed."
    else
        error "Push failed. Check your permissions and remote access."
        exit 1
    fi
}

cmd_config() {
    require_git_repo

    echo -e "\n${CYAN}=== GitHub Configuration ===${NC}\n"

    local clean_url
    clean_url=$(get_clean_remote_url)
    local existing_token
    existing_token=$(extract_token_from_remote)

    # Token
    echo -e "${YELLOW}Current remote URL:${NC} ${clean_url:-not set}"
    if [[ -n "$existing_token" ]]; then
        echo -e "${YELLOW}Existing token:${NC} ${existing_token:0:6}...${existing_token: -4}"
    fi
    read -rp "GitHub PAT [${existing_token:-(none)}]: " input_token
    GIT_TOKEN="${input_token:-$existing_token}"
    if [[ -z "$GIT_TOKEN" ]]; then
        error "Token cannot be empty."
        exit 1
    fi

    # Remote URL
    read -rp "Remote URL [${clean_url:-(current)}]: " input_url
    GIT_REMOTE_URL="${input_url:-$clean_url}"

    # User name
    local current_name
    current_name=$(git config user.name 2>/dev/null || echo "")
    read -rp "Git user.name [${current_name:-(not set)}]: " input_name
    GIT_NAME="${input_name:-$current_name}"

    # User email
    local current_email
    current_email=$(git config user.email 2>/dev/null || echo "")
    read -rp "Git user.email [${current_email:-(not set)}]: " input_email
    GIT_EMAIL="${input_email:-$current_email}"

    # Apply config
    if [[ -n "$GIT_NAME" ]]; then
        git config user.name "$GIT_NAME"
        success "user.name set to: $GIT_NAME"
    fi
    if [[ -n "$GIT_EMAIL" ]]; then
        git config user.email "$GIT_EMAIL"
        success "user.email set to: $GIT_EMAIL"
    fi

    if [[ -n "$GIT_REMOTE_URL" ]]; then
        set_remote_with_token "$GIT_REMOTE_URL" "$GIT_TOKEN"
        success "Remote URL updated."
    fi

    # Save to config file
    cat > "$CONFIG_FILE" <<EOF
# GitHub config - DO NOT COMMIT
GITHUB_TOKEN="$GIT_TOKEN"
GIT_USER_NAME="${GIT_NAME:-}"
GIT_USER_EMAIL="${GIT_EMAIL:-}"
REMOTE_URL="${GIT_REMOTE_URL:-}"
EOF
    chmod 600 "$CONFIG_FILE"
    success "Config saved to $CONFIG_FILE (chmod 600)."

    # Ensure .github-config is in .gitignore
    if [[ -f ".gitignore" ]]; then
        if ! grep -qxF ".github-config" .gitignore; then
            echo ".github-config" >> .gitignore
            success "Added .github-config to .gitignore"
        fi
    else
        echo ".github-config" > .gitignore
        success "Created .gitignore with .github-config"
    fi
}

# --- Usage ---
usage() {
    cat <<EOF
Usage: $(basename "$0") <command> [options]

Commands:
  status              Show branch, status, recent commits, and remote info
  pull                Pull latest changes from remote
  push [-m "msg"]     Stage all, commit, and push (default message: timestamp)
  config              Interactive setup for token, remote URL, name, email

Options:
  -m, --message MSG   Custom commit message (push only)

Environment Variables (optional, override config file):
  GITHUB_TOKEN        GitHub Personal Access Token
  GIT_USER_NAME       Git user.name
  GIT_USER_EMAIL      Git user.email

Config File:
  .github-config      Auto-loaded from repo root (auto-added to .gitignore)

Examples:
  $(basename "$0") status
  $(basename "$0") pull
  $(basename "$0") push
  $(basename "$0") push -m "feat: add new feature"
  $(basename "$0") config
EOF
}

# --- Main ---
main() {
    load_config
    load_env

    local command="${1:-}"
    shift || true

    case "$command" in
        status)
            cmd_status
            ;;
        pull)
            cmd_pull
            ;;
        push)
            # Parse -m flag for commit message
            while [[ $# -gt 0 ]]; do
                case "$1" in
                    -m|--message)
                        COMMIT_MSG="$2"
                        shift 2
                        ;;
                    *)
                        error "Unknown option: $1"
                        usage
                        exit 1
                        ;;
                esac
            done
            cmd_push
            ;;
        config)
            cmd_config
            ;;
        -h|--help|help|"")
            usage
            ;;
        *)
            error "Unknown command: $command"
            usage
            exit 1
            ;;
    esac
}

main "$@"
