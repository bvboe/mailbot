#!/bin/bash
#
# MailBot Installation & Deployment Script
#
# Usage:
#   ./install.sh              # Interactive install or update
#   ./install.sh --init       # Force new installation
#   ./install.sh --push       # Push updates only
#   ./install.sh --open       # Open in browser
#   ./install.sh --status     # Show current configuration
#   ./install.sh --setup-sheet # Create the config Google Sheet
#   ./install.sh --delete     # Delete local config
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# These can be overridden via environment variables so wrapper scripts
# (e.g. install-work.sh / install-private.sh) can target different
# deployment environments without duplicating this script's logic.
CONFIG_FILE="${MAILBOT_CONF:-$SCRIPT_DIR/.mailbot.conf}"
CLASP_FILE="${MAILBOT_CLASP:-$SCRIPT_DIR/.clasp.json}"

# Default folder name in Google Drive
DEFAULT_FOLDER_NAME="MailBot"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Print colored output
info() { echo -e "${BLUE}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[OK]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# Check if clasp is installed
check_clasp() {
    if ! command -v clasp &> /dev/null; then
        echo ""
        echo -e "${RED}clasp is not installed${NC}"
        echo ""
        echo "Install it with:"
        echo "  npm install -g @google/clasp"
        echo ""
        echo "Then authenticate:"
        echo "  clasp login"
        echo ""
        exit 1
    fi
}

# Check clasp authentication
check_login() {
    # Honor clasp's own auth-file env var so wrappers can select a per-env
    # (e.g. work vs private) Google account. Falls back to the global creds.
    local creds_file="${clasp_config_auth:-$HOME/.clasprc.json}"

    if [[ ! -f "$creds_file" ]]; then
        warn "Clasp credentials not found"
        info "Running 'clasp login' to authenticate..."
        clasp login || error "Failed to login. Please run 'clasp login' manually."
        return
    fi

    # Check if credentials file has valid tokens
    if ! grep -q "access_token" "$creds_file" 2>/dev/null; then
        warn "Clasp credentials appear invalid"
        info "Running 'clasp login' to re-authenticate..."
        clasp login || error "Failed to login. Please run 'clasp login' manually."
        return
    fi

    # Test credentials by listing projects
    info "Verifying clasp authentication..."
    set +e
    local test_output
    test_output=$(clasp list 2>&1)
    local exit_code=$?
    set -e

    if [[ $exit_code -ne 0 ]]; then
        if echo "$test_output" | grep -qi "invalid_grant\|invalid_rapt\|reauth\|unauthorized"; then
            warn "Clasp credentials have expired"
            info "Running 'clasp login' to re-authenticate..."
            clasp login || error "Failed to login. Please run 'clasp login' manually."
        else
            warn "Could not verify credentials: $test_output"
        fi
    else
        success "Clasp authenticated"
    fi
}

# Show Apps Script API reminder
check_apps_script_api() {
    echo ""
    echo "Before proceeding, ensure the Apps Script API is enabled:"
    echo "  https://script.google.com/home/usersettings"
    echo ""
    echo "Toggle 'Google Apps Script API' to ON if it's not already."
    echo ""
    read -p "Press Enter when ready to continue (or Ctrl+C to cancel)..."
}

# Load configuration
load_config() {
    if [[ -f "$CONFIG_FILE" ]]; then
        source "$CONFIG_FILE"
    fi
}

# Save configuration
save_config() {
    cat > "$CONFIG_FILE" << EOF
# MailBot Configuration
# Generated on $(date)

# Google Drive folder ID where the Apps Script project and Sheet are stored
DRIVE_FOLDER_ID="$DRIVE_FOLDER_ID"

# Project name in Google Drive
PROJECT_NAME="$PROJECT_NAME"
EOF
    success "Configuration saved to $CONFIG_FILE"
}

# Show current status
show_status() {
    echo ""
    echo "=== MailBot Status ==="
    echo ""

    if [[ -f "$CONFIG_FILE" ]]; then
        success "Configuration file: $CONFIG_FILE"
        load_config
        echo "  Drive Folder ID: ${DRIVE_FOLDER_ID:-<not set>}"
        echo "  Project Name: ${PROJECT_NAME:-<not set>}"
    else
        warn "No configuration file found"
    fi

    echo ""

    if [[ -f "$CLASP_FILE" ]]; then
        success "Project file: $CLASP_FILE"
        local script_id
        script_id=$(grep -o '"scriptId"[[:space:]]*:[[:space:]]*"[^"]*"' "$CLASP_FILE" | cut -d'"' -f4)
        echo "  Script ID: $script_id"
        echo "  Editor URL: https://script.google.com/d/$script_id/edit"
    else
        warn "No .clasp.json found - project not initialized"
    fi

    echo ""
}

# Initialize new project
init_project() {
    info "Initializing new MailBot Apps Script project..."

    check_apps_script_api

    load_config

    # Get project name
    if [[ -z "$PROJECT_NAME" ]]; then
        read -p "Project name [$DEFAULT_FOLDER_NAME]: " PROJECT_NAME
        PROJECT_NAME="${PROJECT_NAME:-$DEFAULT_FOLDER_NAME}"
    else
        info "Using project name: $PROJECT_NAME"
    fi

    # Get Drive folder ID
    if [[ -z "$DRIVE_FOLDER_ID" ]]; then
        echo ""
        echo "The Apps Script project will be created in a Google Drive folder."
        echo ""
        echo "Recommended setup:"
        echo "  1. Create a folder named '$DEFAULT_FOLDER_NAME' in Google Drive"
        echo "  2. Open the folder and copy the ID from the URL:"
        echo "     https://drive.google.com/drive/folders/[FOLDER_ID]"
        echo ""
        echo "Or leave empty to create in Drive root."
        echo ""
        read -p "Google Drive folder ID: " DRIVE_FOLDER_ID
    else
        info "Using Drive folder: $DRIVE_FOLDER_ID"
    fi

    save_config

    # Build clasp create command
    local clasp_cmd="clasp create --type standalone --title \"$PROJECT_NAME\""
    if [[ -n "$DRIVE_FOLDER_ID" ]]; then
        clasp_cmd="$clasp_cmd --parentId \"$DRIVE_FOLDER_ID\""
    fi

    # Create the project
    info "Creating Apps Script project..."
    cd "$SCRIPT_DIR"

    # `clasp create` treats clasp_config_project as an EXISTING project to read,
    # so it fails when a wrapper points it at a not-yet-created env file. Run
    # create without that var (clasp writes the default .clasp.json), then move
    # the result into this environment's CLASP_FILE below.
    set +e
    local output
    output=$(unset clasp_config_project; eval $clasp_cmd 2>&1)
    local exit_code=$?
    set -e

    if [[ $exit_code -ne 0 ]]; then
        echo ""
        if echo "$output" | grep -qi "invalid_grant\|invalid_rapt\|reauth"; then
            echo -e "${RED}Authentication Error:${NC} Clasp credentials expired."
            echo ""
            echo "Run: clasp login"
            echo "Then: ./install.sh"
        elif echo "$output" | grep -qi "denied\|forbidden"; then
            echo -e "${RED}Permission Error:${NC} Access denied."
            echo ""
            echo "Make sure Apps Script API is enabled:"
            echo "  https://script.google.com/home/usersettings"
        else
            echo -e "${RED}Error:${NC} $output"
        fi
        exit 1
    fi

    echo "$output"

    # clasp writes .clasp.json in the project root; move it into this
    # environment's slot (no-op when CLASP_FILE is already .clasp.json).
    local default_clasp="$SCRIPT_DIR/.clasp.json"
    if [[ "$CLASP_FILE" != "$default_clasp" && -f "$default_clasp" ]]; then
        mv "$default_clasp" "$CLASP_FILE"
        info "Saved project config to $CLASP_FILE"
    fi

    if [[ -f "$CLASP_FILE" ]]; then
        success "Apps Script project created!"

        info "Pushing code to Apps Script..."
        clasp push
        success "Code deployed!"

        # Open editor and show instructions
        echo ""
        echo "=== Final Step: Create Config Sheet ==="
        echo ""
        echo "Opening the Apps Script editor..."
        echo ""

        open_project

        echo "To create the config sheet:"
        echo ""
        echo "  1. Select 'createConfigSheet' from the function dropdown (defined in Config.gs)"
        echo "  2. Click Run"
        echo "  3. Authorize when prompted"
        echo "  4. Check View → Logs for the Sheet URL"
        echo ""
        echo "Then configure your API keys and start the bot using the"
        echo "sidebar in the spreadsheet (MailBot menu → Open Control Panel)."
        echo ""
    else
        error "Failed to create Apps Script project"
    fi
}

# Push updates
push_updates() {
    if [[ ! -f "$CLASP_FILE" ]]; then
        error "Project not initialized. Run: ./install.sh --init"
    fi

    info "Pushing updates to Apps Script..."
    cd "$SCRIPT_DIR"
    clasp push
    success "Updates deployed!"
}

# Open in browser
open_project() {
    if [[ ! -f "$CLASP_FILE" ]]; then
        error "Project not initialized. Run: ./install.sh --init"
    fi

    local script_id
    script_id=$(grep -o '"scriptId"[[:space:]]*:[[:space:]]*"[^"]*"' "$CLASP_FILE" | cut -d'"' -f4)

    if [[ -z "$script_id" ]]; then
        error "Could not find scriptId in $CLASP_FILE"
    fi

    local url="https://script.google.com/d/${script_id}/edit"

    info "Opening Apps Script editor..."
    echo "  $url"
    echo ""

    if [[ "$OSTYPE" == "darwin"* ]]; then
        open "$url"
    elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
        xdg-open "$url" 2>/dev/null || echo "Please open the URL manually"
    else
        echo "Please open this URL in your browser"
    fi
}

# Create the config Google Sheet (if skipped during install)
setup_sheet() {
    if [[ ! -f "$CLASP_FILE" ]]; then
        error "Project not initialized. Run: ./install.sh --init"
    fi

    info "Pushing latest code..."
    cd "$SCRIPT_DIR"
    clasp push

    echo ""
    echo "To create the config Sheet:"
    echo ""
    echo "  1. Select 'createConfigSheet' from the function dropdown (defined in Config.gs)"
    echo "  2. Click Run"
    echo "  3. Authorize when prompted"
    echo "  4. Check View → Logs for the Sheet URL"
    echo ""
    read -p "Press Enter to open the editor..."

    open_project
}

# Delete local configuration
delete_project() {
    echo ""
    echo "=== Delete MailBot Configuration ==="
    echo ""

    local has_files=false

    if [[ -f "$CLASP_FILE" ]]; then
        has_files=true
        local script_id
        script_id=$(grep -o '"scriptId"[[:space:]]*:[[:space:]]*"[^"]*"' "$CLASP_FILE" | cut -d'"' -f4)
    fi

    [[ -f "$CONFIG_FILE" ]] && has_files=true

    if [[ "$has_files" == false ]]; then
        info "No local configuration found. Nothing to delete."
        return
    fi

    echo "This will delete local configuration files:"
    echo ""
    [[ -f "$CLASP_FILE" ]] && echo "  - .clasp.json"
    [[ -f "$CONFIG_FILE" ]] && echo "  - .mailbot.conf"
    echo ""
    echo "Note: The remote Apps Script project and Google Sheet will NOT be deleted."
    echo "      Delete them manually from Google Drive if needed."
    if [[ -n "$script_id" ]]; then
        echo ""
        echo "      Apps Script: https://script.google.com/d/$script_id/edit"
    fi
    echo ""

    read -p "Are you sure? (y/N): " confirm
    if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
        info "Cancelled"
        return
    fi

    [[ -f "$CLASP_FILE" ]] && rm -f "$CLASP_FILE" && success "Deleted .clasp.json"
    [[ -f "$CONFIG_FILE" ]] && rm -f "$CONFIG_FILE" && success "Deleted .mailbot.conf"

    echo ""
    success "Local configuration deleted. Run ./install.sh to start fresh."
}

# Main logic
main() {
    check_clasp

    case "${1:-}" in
        --init)
            check_login
            if [[ -f "$CLASP_FILE" ]]; then
                warn "Project already initialized!"
                read -p "Delete existing and create new? (y/N): " confirm
                if [[ "$confirm" =~ ^[Yy]$ ]]; then
                    rm -f "$CLASP_FILE" "$CONFIG_FILE"
                    init_project
                else
                    info "Aborted"
                fi
            else
                init_project
            fi
            ;;
        --push)
            check_login
            push_updates
            ;;
        --open)
            open_project
            ;;
        --status)
            show_status
            ;;
        --setup-sheet)
            check_login
            setup_sheet
            ;;
        --delete)
            delete_project
            ;;
        --help|-h)
            echo "MailBot Installation & Deployment Script"
            echo ""
            echo "Usage:"
            echo "  ./install.sh              Interactive install or update"
            echo "  ./install.sh --init       Force new installation"
            echo "  ./install.sh --push       Push updates only"
            echo "  ./install.sh --open       Open in browser"
            echo "  ./install.sh --status     Show current configuration"
            echo "  ./install.sh --setup-sheet Create the config Google Sheet"
            echo "  ./install.sh --delete     Delete local configuration"
            echo "  ./install.sh --help       Show this help"
            ;;
        "")
            check_login

            # Check for inconsistent state
            if [[ -f "$CLASP_FILE" && ! -f "$CONFIG_FILE" ]]; then
                warn "Found .clasp.json but no .mailbot.conf"
                echo ""
                echo "This may indicate a stale configuration."
                echo ""
                echo "  1) Start fresh (recommended)"
                echo "  2) Keep existing .clasp.json"
                echo ""
                read -p "Choice [1]: " choice
                choice="${choice:-1}"

                if [[ "$choice" == "1" ]]; then
                    rm -f "$CLASP_FILE"
                    init_project
                else
                    show_status
                fi
            elif [[ -f "$CLASP_FILE" ]]; then
                info "Project already initialized"
                show_status
                echo ""
                echo "What would you like to do?"
                echo "  1) Push updates"
                echo "  2) Open in browser"
                echo "  3) Create config Sheet"
                echo "  4) Re-initialize (create new project)"
                echo "  5) Exit"
                echo ""
                read -p "Choice [1]: " choice
                choice="${choice:-1}"

                case "$choice" in
                    1) push_updates ;;
                    2) open_project ;;
                    3) setup_sheet ;;
                    4)
                        read -p "This will create a NEW project. Continue? (y/N): " confirm
                        if [[ "$confirm" =~ ^[Yy]$ ]]; then
                            rm -f "$CLASP_FILE" "$CONFIG_FILE"
                            init_project
                        fi
                        ;;
                    5) info "Bye!" ;;
                    *) warn "Invalid choice" ;;
                esac
            else
                init_project
            fi
            ;;
        *)
            error "Unknown option: $1. Use --help for usage."
            ;;
    esac
}

main "$@"
