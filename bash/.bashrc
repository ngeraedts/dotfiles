# User specific aliases and functions
# Everyone needs a little color in their lives
color() {
    echo "\e[38;5;${1}m"
}
GREEN="$(color 41)"
YELLOW="$(color 11)"
BLUE="$(color 27)"
PURPLE='\[\e[0;35m\]'
CYAN="$(color 45)"
WHITE="$(color 255)"
NIL='\[\e[00m\]'

function git_branch() {
    # -- Finds and outputs the current branch name by parsing the list of
    #    all branches
    # -- Current branch is identified by an asterisk at the beginning
    # -- If not in a Git repository, error message goes to /dev/null and
    #    no output is produced
    git branch --no-color 2>/dev/null | sed -e '/^[^*]/d' -e 's/* \(.*\)/\1/'
}

function git_status() {
    # Outputs a series of indicators based on the status of the
    # working directory:
    # + changes are staged and ready to commit
    # ! unstaged changes are present
    # ? untracked files are present
    # S changes have been stashed
    # P local commits need to be pushed to the remote
    local status
    local output
    status="$(git status --porcelain 2>/dev/null)"
    output=''
    grep -E -q '^[MADRC]' <<<"$status" && output="$output+"
    grep -E -q '^.[MD]' <<<"$status" && output="$output!"
    echo $output
}

function git_color() {
    # Receives output of git_status as argument; produces appropriate color
    # code based on status of working directory:
    # - White if everything is clean
    # - Green if all changes are staged
    # - Yellow if there are both staged and unstaged changes
    local staged
    local dirty
    staged=$([[ $1 =~ \+ ]] && echo yes)
    dirty=$([[ $1 =~ [!\?] ]] && echo yes)
    if [[ -n $staged ]]; then
        echo -e "${GREEN}"  # bold green
    elif [[ -n $dirty ]]; then
        echo -e "${YELLOW}"  # bold red
    else
        echo -e "${WHITE}"  # bold white
    fi
}

function git_prompt() {
    # First, get the branch name...
    local branch
    local state
    local color
    branch=$(git_branch)
    # Empty output? Then we're not in a Git repository, so bypass the rest
    # of the function, producing no output
    if [[ -n "$branch" ]]; then
        state=$(git_status)
        color=$(git_color "$state")
        # Now output the actual code to insert the branch and status
        echo -e "${color}[git: $branch]${NIL}"  # last bit resets color
    fi
}

function base() {
    module purge > /dev/null 2>&1
    module load zymeworks/base
}

function suite() {
    module purge > /dev/null 2>&1
    if [[ -n $1 ]]; then
        module load "zymeworks/suite/${1}"
    else
        module load zymeworks/suite
    fi
}

function gcs() {
    git clone "git@gitlab.zymeworks.com:nicholas.geraedts/${1}.git"
    cd "${1}" || return
    git remote add software "git@gitlab.zymeworks.com:software/${1}.git"
    git fetch software
    git merge software/master
    cd - || return
}

alias fstatus="floss-status --workspace run"

function fstage() {
    if [[ -n $2 ]]; then
        iter="--iterations $2"
    fi
    floss-stage --workspace run --node "{1}" "${iter}" --dest "stage/${1}/${2}"
}

function set_prompt() {
    host="${BLUE}\h${NIL}"
    path="${CYAN}\w${NIL}"
    myuser="${GREEN}\u${NIL}"
    end="${NIL}> "

    venv=""
    if [[ -n "$VIRTUAL_ENV" ]]; then

        py=""
        if [[ -n "$PYTHON2_VERSION" ]]; then
            py="py2"
        elif [[ -n "$PYTHON3_VERSION" ]]; then
            py="py3"
        fi

        venv=" ${PURPLE}(${py}:${VIRTUAL_ENV##*/})${NIL}"
    fi

    PS1="${myuser}@${host} ${path} $(git_prompt)${venv}${NIL}\n${end}"
    export PS1
}

function dataset_env() {
    FFDB_ROOT="/Network/Datasets/ffdb/3.5"
    KBP_POTENTIAL_ROOT="/Network/Datasets/kbp/3.7"
    ALTCONF_REFERENCE_ROOT="/Network/Datasets/altconf/1.0"
    export ALTCONF_REFERENCE_ROOT FFDB_ROOT KBP_POTENTIAL_ROOT
}

export PROMPT_COMMAND=set_prompt

# Change virtualenv root on cluster
if [[ $SGE_CELL == "cluster" ]]; then
    export WORKON_HOME="/Network/Cluster/project/validation_testing_2/nick/venvs"
fi

# Only autocomplete directories
complete -d cd

bind '"\e[A":history-search-backward'
bind '"\e[B":history-search-forward'

# Aliases
unamestr=$(uname)
if [[ "$unamestr" == "Linux" ]]; then
    alias ls='ls --color --group-directories-first'
elif [[ "$unamestr" == "Darwin" ]]; then
    export PATH="${HOME}/brew/bin:${PATH}"
    [[ $(which gls) ]] && alias ls='gls --color --group-directories-first'
fi

alias ll='ls -l'

# Navigation helpers
alias ..='cd ..'
alias ...='cd ../..'

# ignore some patterns for the basic tree command
alias treeall='tree --dirsfirst -C -I ".git"'
alias tree="tree --dirsfirst -C -I \".git|*.pyc|*.egg-info|build|__pycache__|venv*|deps|_build|node_modules|elm-stuff|vendor\""

# Run Phoenix server
alias phx='iex -S mix phx.server'

function vsh() {
    pushd ~/vagrant > /dev/null || return
    vagrant ssh "${1:-web}"
    popd > /dev/null || return
}

function vsh() {
    pushd ~/vagrant > /dev/null
    vagrant ssh $1
    popd > /dev/null
}


if [[ :$PATH: != *:"~/.local/bin":* ]] ; then
    export PATH=~/.local/bin:$PATH
fi


# Install asdf if missing and git available
# Only do this on macos, as vagrant has this part of /etc/profile.d
if [[ $(whoami) != "vagrant" ]]; then
    if [[ -d "$HOME/.asdf" ]]; then
        source "$HOME/.asdf/asdf.sh"
        source "$HOME/.asdf/completions/asdf.bash"
    fi
fi

completions="
/opt/vagrant/embedded/gems/2.2.10/gems/vagrant-2.2.10/contrib/bash/completion.sh
~/.git-completions.bash
"

for c in $completions; do
    [[ -f "${c}" ]] && . "${c}"
done
