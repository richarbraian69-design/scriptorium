# Scriptorium

Versão de servidor do Scriptorium: banco de estudos, latim (Familia Romana) e violino.

- Entra-se com nome e senha. O primeiro acesso cria a conta do administrador e já deixa o latim no capítulo VI e os quatro exercícios de violino.
- Os dados ficam em `scriptorium.json` no disco do Railway (`/data`), com uma cópia de segurança por dia em `/data/backups` (as últimas 30).
- O que é salvo num aparelho aparece na hora nos outros que estiverem abertos.

## Arquivos e sala de estudo

- Os arquivos enviados pelo app ficam em `/data/arquivos`, só para quem entra com senha, e nunca vão para o GitHub. As cópias diárias e o `/api/exportar` guardam só as fichas e notas, não os arquivos em si.
- O espaço é o do volume do Railway. Para guardar vídeos, aumente o volume no painel do Railway.
- Abrem na tela: PDF (leitor pdf.js em `publico/vendor`), vídeo, áudio, imagem e texto. Outros formatos ficam para baixar.
- Links do YouTube, Vimeo e Google Drive abrem dentro da sala. Outros sites abrem em nova aba, porque não permitem ser exibidos em outra página.
- A sala de latim conhece o PDF do Familia Romana de 332 páginas (`LIVRO` em `publico/index.html`). Um PDF com outra paginação abre normalmente, sem os atalhos de capítulo.

## Dicionário

Na sala de estudo e na página Latim, digitar uma palavra traz o significado pelo Claude, e uma frase de até 800 letras é traduzida ao apertar Enter. No modo Corrigir exercício, o Claude confere a resposta (com o enunciado, se houver) e aponta cada erro com a explicação. Precisa de `ANTHROPIC_API_KEY` no Railway; sem ela, o resto do app funciona normalmente. O modelo padrão é `claude-opus-5-5` e muda com `ANTHROPIC_MODELO`. Cada palavra consultada fica guardada no disco e não gasta de novo.

## Railway

1. Serviço ligado a este repositório (Node.js, `npm start`).
2. Volume montado em `/data` (obrigatório: sem ele os dados somem a cada atualização).
3. Gerar o domínio em Settings → Networking.

Para conferir o disco, abra `https://SEU-ENDERECO/diagnostico`. Para baixar uma cópia dos dados, abra `https://SEU-ENDERECO/api/exportar` já logado.

## Atualizar

Troque `publico/index.html` (ou `servidor.js`) no GitHub e faça o commit. O Railway publica sozinho e os dados continuam no disco.

## Rodar no computador

Node.js 20 ou mais novo: `npm install` e `npm start`, depois abra <http://localhost:3000>.

## Porta do JARVIS (assistente do Mac)

O JARVIS acompanha os estudos direto pelo servidor, nas rotas `/api/jarvis/...`, sem abrir a tela.

- A chave fica só no `.env` do JARVIS, como `SCRIPTORIUM_TOKEN`. No Railway vai apenas a impressão digital dela, na variável `JARVIS_TOKEN_SHA256` (SHA-256 em hex; no Mac: `printf %s "CHAVE" | shasum -a 256`). Sem a variável, as rotas não existem.
- Ele lê o resumo (sequência de dias, minutos de latim e violino, capítulo, vocabulário a revisar, banco) e pode anotar um estudo feito ou pôr um item novo no banco. Não apaga nem altera nada.
- O que ele anota aparece com "via: jarvis" e pode ser apagado pela tela.
- Para desligar, apague a variável `JARVIS_TOKEN_SHA256`.
