# Meu Downloader

Gerenciador de downloads pessoal para Windows, com download segmentado dinâmico,
retomada, fila, limite de velocidade e integração com Chrome/Edge.

O design foi inspirado no comportamento observado do Internet Download Manager.
Todo o código é original: o projeto não usa binários, ícones, extensões nem a
marca do IDM.

## Como funciona

- **Segmentação dinâmica.** O primeiro pedido (`Range: bytes=0-`) descobre o tamanho
  e se o servidor aceita retomada. Quando sobra uma conexão livre, ela assume a
  segunda metade do maior trecho que ainda falta. A conexão original percebe o
  novo limite e para ali, então o arquivo é redividido durante o download, sem
  tamanho fixo por parte.
- **Retomada.** O arquivo é pré-alocado (`.mdpart`) e cada segmento grava na sua
  posição. O estado dos segmentos fica salvo em `downloads.json`. Ao retomar, o app
  envia `If-Range` com o `ETag`/`Last-Modified`. Se o arquivo mudou no servidor,
  o download recomeça do zero em vez de corromper.
- **Falhas.** Conexões que caem são reabertas a partir do último byte gravado, com
  espera crescente entre tentativas.
- **Servidores sem `Range`.** O app usa uma única conexão. Tamanho desconhecido
  também funciona.
- **Sessão do navegador.** A extensão envia cookies, `Referer` e `User-Agent`, o que
  permite baixar arquivos de sites com login.

## Vídeos (YouTube e outros sites)

Links de páginas de vídeo (YouTube, Vimeo, TikTok, Instagram, X, Twitch,
SoundCloud e outros) são baixados pelo [yt-dlp](https://github.com/yt-dlp/yt-dlp),
que fica na pasta `bin/` junto com o [ffmpeg](https://github.com/yt-dlp/FFmpeg-Builds).
O YouTube entrega áudio e vídeo separados em HD; o ffmpeg junta os dois em um MP4.
Se qualquer outro link abrir uma página web em vez de um arquivo, o app tenta
extrair o vídeo da página automaticamente.

- A qualidade é escolhida no diálogo **Adicionar** (padrão em **Configurações**):
  melhor disponível, até 4K/1440p/1080p/720p/480p/360p, ou só áudio em MP3.
  O limite vale para o lado menor, então "1080p" em um Short vertical é 1080×1920.
- Pausar e retomar funciona. O yt-dlp continua os arquivos `.part`.
- O YouTube muda com frequência. Se os vídeos pararem de baixar, use
  **Configurações → Atualizar yt-dlp**.
- O próprio Electron executa os desafios JavaScript do YouTube; não é preciso
  instalar Deno nem Node.
- No navegador, o botão direito na página mostra **Baixar vídeo desta página com Meu Downloader**.

Baixe apenas conteúdo que você tem direito de baixar. Respeite os termos de
uso de cada site e os direitos autorais.

Se a pasta `bin/` não existir, baixe `yt-dlp.exe` da página de releases do
yt-dlp e o `ffmpeg-master-latest-win64-gpl-shared.zip` do FFmpeg-Builds, e
copie o `yt-dlp.exe`, o `ffmpeg.exe`, o `ffprobe.exe` e as DLLs para `bin/`.

## Instalação

Requer Node.js 22 ou mais novo.

```bash
cd D:\projetos\meu-downloader
npm install
npm start
```

Ao fechar a janela, o app continua na bandeja do sistema (ao lado do relógio)
e os downloads seguem em andamento. Para encerrar, use **Sair** no menu da bandeja.
Downloads em andamento continuam automaticamente na próxima vez que o app abrir.

Para abrir sem console, dê dois cliques em `Meu Downloader.vbs`. Você pode criar um
atalho dele na área de trabalho ou em `shell:startup`, para iniciar com o Windows.

## Extensão do navegador (Chrome ou Edge)

1. Abra `chrome://extensions` (ou `edge://extensions`).
2. Ative o **Modo do desenvolvedor**.
3. Clique em **Carregar sem compactação** e escolha a pasta `extension`.

Com o app aberto, downloads dos tipos configurados (zip, exe, mp4, iso, pdf…) são
cancelados no navegador e enviados ao app. Com o app fechado, o navegador baixa
normalmente. O botão direito sobre links e mídias mostra **Baixar com Meu Downloader**.
O ícone da extensão indica o estado (`!` = app fechado, `OFF` = captura desligada)
e permite ligar ou desligar a captura.

Por segurança, a ponte local (`127.0.0.1:47900`) só aceita pedidos de extensões,
nunca de páginas web.

## Configurações

No botão **Configurações**:

- Pasta de downloads
- Conexões por download (padrão 8, máximo 32)
- Downloads simultâneos (padrão 3)
- Limite de velocidade global em KB/s (0 = sem limite)
- Tipos de arquivo capturados e tamanho mínimo para captura

Atalhos: `Ctrl+N` adiciona uma URL, `Delete` remove, `Ctrl+A` seleciona tudo,
`Enter` ou duplo clique abre o arquivo concluído (ou pausa/retoma). Também é
possível arrastar um link do navegador para a janela.

## Dados

Configurações e lista de downloads ficam em `%APPDATA%\meu-downloader`.
Para um perfil separado (por exemplo, uma cópia portátil), defina a variável
`MD_USER_DATA` com outra pasta antes de iniciar.

## Testes

```bash
npm test
```

Os testes sobem um servidor HTTP local e cobrem: segmentação e paralelismo,
pausa e retomada a partir do estado salvo, servidor sem `Range`, tamanho
desconhecido, redirecionamento com `Content-Disposition`, conexões que caem,
erros HTTP, recusa de páginas web, limite de velocidade, fila do gerenciador,
a segurança da ponte com a extensão e, com o yt-dlp real, download de vídeo,
pausa/retomada e conversão automática de página com player em vídeo.

## Limitações

- Não há botão "baixar vídeo" desenhado sobre os players; use o menu do botão direito
  ou cole o link.
- Vídeos privados ou que exigem login não são suportados (o app não envia os cookies
  do navegador ao yt-dlp).
- Conteúdo com DRM (Netflix, Spotify, Disney+ etc.) não pode ser baixado.
- Downloads iniciados por formulário (POST) não são reproduzidos pelo app. A
  extensão não consegue repetir o corpo do pedido, então eles continuam no navegador.
- Não há suporte a FTP.
