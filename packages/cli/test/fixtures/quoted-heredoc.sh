cat > note.md <<'EOF'
Branches that don't touch the runbook still fail.
The line "gh pr create" inside this file is text.
EOF
gh issue create --body-file note.md
