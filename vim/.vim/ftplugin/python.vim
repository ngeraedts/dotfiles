" Python tab settings
setlocal expandtab
setlocal tabstop=4
setlocal shiftwidth=4
setlocal softtabstop=4

" Wrap comments at 100 characters
setlocal textwidth=79
setlocal formatoptions-=t
setlocal formatoptions+=c1j

" Highlight lines longer than 90 characters
hi Col101   guibg=#610b0b
hi Col100   guibg=#61380b
hi Col119   guibg=#890b0b
let w:m2=matchadd('Col101', '\%>100v.\+', -1)
let w:m1=matchadd('Col100', '\%<101v.\%>100v',-1)
let w:m3=matchadd('Col119', '\%>119v.\+', -1)
