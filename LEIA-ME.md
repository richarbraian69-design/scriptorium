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

Palavras em português também vão para o vocabulário: o Claude busca a definição sozinho. Quando a palavra nomeia algo concreto (objeto, animal, planta, lugar), o servidor pega a foto principal do artigo da Wikipédia indicado pelo Claude e mostra com o link para a página da imagem.

## Educação clássica

A seção Educação clássica é um mapa de estudos do Trivium e do Quadrivium: 64 obras, dos gregos aos documentos da Igreja sobre educação, em sete etapas, com três formatos de mapa (a questão, linha do tempo e as sete artes), ficha de cada obra (textos para ler, situação, posição na questão, perguntas-guia, síntese conferida pelo Claude, conceitos que viram flashcards), uma quaestio disputata, um cofre de citações e o caderno do fundador. O catálogo fica em `OBRAS_CLS` e os textos de cada obra em `FONTES_CLS`, no `publico/index.html`; o que o aluno escreve fica na coleção `classica`.

Os textos de cada obra (traduções em domínio público, documentos do vatican.va, PDFs de acesso aberto) são baixados pelo próprio servidor (`fontes.js`, rota `/api/classica/fontes`) e guardados em `/data/arquivos`, como os outros arquivos, com o campo `obra`. PDFs ficam como estão; páginas viram uma cópia de leitura em HTML limpo, sem scripts, servida com `Content-Security-Policy: sandbox`. Só os sites listados em `fontes.js` podem ser baixados. Os textos não vão para o GitHub: ficam só no disco do Railway. Na primeira visita à seção, o app pede os textos que faltam; o resto aparece na ficha como "Abrir no site".

## Memória

A prática diária de memorização: o Evangelho de Lucas na Vulgata Clementina (`publico/memoria/lucas.json`, 1151 versículos, do Clementine Vulgate Project via eBible.org, domínio público) e Os Lusíadas (`publico/memoria/lusiadas.json`, 1102 estrofes, do Projeto Gutenberg n.º 3333, domínio público; as estrofes VII, 15, III, 130 e VIII, 61 foram corrigidas pela edição de 1572, n.º 27236). Cada dia: revisar o que vence (os intervalos do vocabulário), aprender o trecho novo (ler, só as iniciais, de cor) e encadear com o trecho anterior; a avaliação é do próprio aluno. Meta padrão: 2 versículos e 1 estrofe por dia. Há também 30 poemas curtos, 10 por língua, em `publico/memoria/poemas-latim.json`, `poemas-ingles.json` e `poemas-portugues.json` (hinos da Igreja, Horácio, Catulo e a abertura da Eneida; Hopkins, Newman, Donne, Herbert, Southwell, Chesterton, Milton, Keats e Tennyson; Camões, Bilac, Antero, Pessoa, Gonçalves Dias, Machado e Gregório de Matos), todos em domínio público, conferidos com edições antigas no Wikisource, na Wikipédia e na Latin Library; nos textos antigos a grafia foi atualizada. Cada poema é dividido em estrofes, e o encadeamento fica dentro do mesmo poema. O estado fica em `estado/memoria`.

## Eneida

A sala da Eneida (página Latim) traz os doze livros em latim, em `publico/eneida`. O texto é o da edição de J. B. Greenough (1900), de domínio público, preparado pela Perseus Digital Library.

- **Ler, Traduzir e Pintar:** o Claude analisa cada verso uma única vez (tradução, classe e caso de cada palavra, escansão) e a análise fica guardada no disco. Ela serve de gabarito para a pintura.
- **Som:** "Ouvir" usa a voz do navegador. "Cantar" toca uma voz sintética que canta o verso: `canto.js` sintetiza cada sílaba com o eSpeak (pacote `mespeak`, licença GPL) na nota e na duração dadas pela escansão. O áudio fica guardado em `/data/canto`.
- As pinturas e traduções do aluno ficam na coleção `eneida`, uma ficha por verso.

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
