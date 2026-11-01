# Scriptorium

Versão de servidor do Scriptorium: banco de estudos, latim (Familia Romana) e violino.

- Entra-se com nome e senha. O primeiro acesso cria a conta do administrador e já deixa o latim no capítulo VI e os quatro exercícios de violino.
- Os dados ficam em `scriptorium.json` no disco do Railway (`/data`), com uma cópia de segurança por dia em `/data/backups` (as últimas 30).
- O que é salvo num aparelho aparece na hora nos outros que estiverem abertos.

## Railway

1. Serviço ligado a este repositório (Node.js, `npm start`).
2. Volume montado em `/data` (obrigatório: sem ele os dados somem a cada atualização).
3. Gerar o domínio em Settings → Networking.

Para conferir o disco, abra `https://SEU-ENDERECO/diagnostico`. Para baixar uma cópia dos dados, abra `https://SEU-ENDERECO/api/exportar` já logado.

## Atualizar

Troque `publico/index.html` (ou `servidor.js`) no GitHub e faça o commit. O Railway publica sozinho e os dados continuam no disco.

## Rodar no computador

Node.js 20 ou mais novo: `npm install` e `npm start`, depois abra <http://localhost:3000>.
