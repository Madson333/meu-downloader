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
- **Vídeos com login (contas suas).** Em **Configurações → Cookies para vídeos com login**
  escolha de onde vêm os cookies que o yt-dlp usa:
  - **Não usar** (padrão).
  - **Sessão enviada pela extensão do navegador:** os cookies que a extensão mandou junto
    com o link. Eles valem só para o site do link.
  - **Ler do Firefox:** o yt-dlp lê o perfil do Firefox (`--cookies-from-browser firefox`).
  - **Arquivo cookies.txt** no formato Netscape.

  O app grava uma cópia temporária em `%APPDATA%\meu-downloader\sessions` e a apaga
  quando o yt-dlp termina. O seu `cookies.txt` nunca é alterado e os cookies não vão
  para nenhum log. Chrome e Edge não aparecem como fonte direta porque cifram os
  cookies de um jeito que o yt-dlp não consegue ler; use a extensão.

## Streams HLS e DASH (sem DRM)

Links `.m3u8` (HLS) e `.mpd` (MPEG-DASH) são baixados pelo próprio app, com as
mesmas conexões, fila, limite de velocidade, pausa e retomada dos outros downloads.
Um link sem essa extensão também é reconhecido quando o servidor responde com o
tipo de um manifesto. O app:

1. Lê o manifesto e escolhe a qualidade pedida (veja abaixo).
2. Escolhe o áudio padrão (HLS: `DEFAULT=YES`; DASH: o conjunto com papel `main`, na
   maior taxa) e as legendas WebVTT da variante.
3. Baixa os segmentos em paralelo (até o número de conexões configurado), tentando de
   novo em falhas temporárias de rede e respostas 5xx/429.
4. Junta os segmentos de cada faixa na ordem e usa o FFmpeg para unir áudio e vídeo
   **sem recodificar** (`-c copy`): MP4, ou MKV se o MP4 não aceitar os codecs. Só
   áudio vira M4A (ou MKA).
5. Confere o arquivo final com o ffprobe antes de marcar como concluído.

Legendas são salvas ao lado do vídeo (`nome.pt.vtt`). O painel de detalhes mostra o
tipo (HLS/DASH), as faixas escolhidas, os segmentos baixados e os avisos.

**Qualidade.** As opções são as mesmas dos vídeos (melhor, até 4K/1440p/1080p/720p/480p/360p,
só áudio) e valem para o lado menor da imagem. O app usa a maior resolução que não passa
do limite; em empate, H.264 e depois a maior taxa de bits. Se a resolução pedida não
existir, ele usa a maior abaixo, ou a menor de todas se nenhuma couber, e mostra um
aviso dizendo o que escolheu. "Só áudio" usa a faixa de áudio separada quando existe;
se não existir, extrai o áudio da menor variante de vídeo e avisa.

**Formatos suportados:**

- HLS: playlist principal e de mídia, segmentos TS, fMP4 (`EXT-X-MAP`), AAC/MP3,
  `EXT-X-BYTERANGE`, áudio e legendas WebVTT em renditions separadas e criptografia
  **AES-128** padrão (a chave é pedida ao próprio site, com a sua sessão).
- DASH estático: `SegmentTemplate` (com `$Number$`, `$Time$`, `SegmentTimeline`),
  `SegmentList`, `SegmentBase`/`BaseURL` de arquivo único, `BaseURL` em vários níveis
  e legendas WebVTT em arquivo único.

**Não suportados** (o app mostra a mensagem e não baixa):

- Transmissões ao vivo (HLS sem `EXT-X-ENDLIST`, DASH `type="dynamic"`).
- DASH com vários `Period` (por exemplo, com anúncios inseridos).
- HLS com mais de um `EXT-X-MAP`.
- Legendas TTML/IMSC ou segmentadas em MP4 (são ignoradas, com aviso).
- `SAMPLE-AES` e qualquer DRM (veja abaixo).

**Retomada.** Cada segmento só aparece na pasta temporária `<id>.mdstream` depois
de recebido inteiro, então pausar, fechar o app ou perder a conexão não estraga
nada. Ao retomar, o manifesto é lido de novo (os links costumam ter tokens que
expiram) e comparado com o original. Se ainda descreve o mesmo conteúdo, só os
segmentos que faltam são baixados. Se mudou, o download recomeça e um aviso
explica o motivo. Se o FFmpeg falhar, a pasta temporária fica guardada e **Retomar**
tenta juntar de novo sem baixar outra vez. Remover o download apaga a pasta.

Sem o FFmpeg na pasta `bin/`, streams de uma faixa só são salvos no formato original
(`.ts`, `.mp4`); streams com áudio e vídeo separados mostram um erro pedindo o FFmpeg.

**Segurança.** Os cookies do link vão só para o servidor do link, nunca para CDNs de
outros endereços. Se o manifesto está na internet, os endereços que ele indica (segmentos,
chaves, legendas e redirecionamentos) não podem apontar para a rede local nem para o
próprio computador. Isso é verificado na resolução de DNS de cada conexão. Manifestos
são limitados a 20 MB, o XML não aceita `DOCTYPE` e os segmentos são gravados direto no
disco, sem ficar na memória. O FFmpeg é chamado com argumentos separados, sem shell.

### Mídia com DRM

O Meu Downloader **não baixa nem tenta abrir conteúdo com DRM** (Widevine, PlayReady,
FairPlay, CENC ou SAMPLE-AES). Isso inclui Netflix, Disney+, Prime Video, Spotify e
semelhantes. O app recusa o download quando:

- o HLS tem `EXT-X-KEY`/`EXT-X-SESSION-KEY` com `KEYFORMAT` diferente de `identity` ou
  método `SAMPLE-AES`;
- o DASH tem qualquer `ContentProtection`;
- o segmento de inicialização MP4 declara criptografia (`encv`, `enca`, `sinf`, `pssh`),
  mesmo que o manifesto não diga.

Não há extração de chaves, uso de CDMs nem contorno de servidores de licença.

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

O código é TypeScript (modo `strict`). `npm start` compila e abre o app; para só
compilar, use `npm run build`, e para só checar os tipos, `npm run typecheck`.

| Pasta | Conteúdo | Configuração |
|---|---|---|
| `src/engine`, `src/main`, `test`, `scripts` | motor de download, processo principal, testes | `tsconfig.json` (Node, CommonJS) |
| `src/renderer` | interface | `src/renderer/tsconfig.json` (navegador, módulo ES) |
| `extension/src` | extensão do navegador | `extension/tsconfig.json` (`@types/chrome`) |
| `src/shared/api.d.ts` | tipos trocados entre o processo principal e a interface | — |

A compilação vai para `dist/` (o `main` do `package.json` aponta para
`dist/src/main/main.js`). A extensão é compilada dentro da própria pasta `extension/`
(`background.js` e `popup.js`). Esses arquivos gerados ficam fora do git.

Ao fechar a janela, o app continua na bandeja do sistema (ao lado do relógio)
e os downloads seguem em andamento. Para encerrar, use **Sair** no menu da bandeja.
Downloads em andamento continuam automaticamente na próxima vez que o app abrir.

Para abrir sem console, dê dois cliques em `Meu Downloader.vbs`. Ele compila o código
antes de abrir, então sempre roda a versão atual. Você pode criar um atalho dele na
área de trabalho ou em `shell:startup`, para iniciar com o Windows.

## Extensão do navegador (Chrome ou Edge)

1. Rode `npm run build` (gera `extension/background.js` e `extension/popup.js`).
2. Abra `chrome://extensions` (ou `edge://extensions`).
3. Ative o **Modo do desenvolvedor**.
4. Clique em **Carregar sem compactação** e escolha a pasta `extension`.

Depois de mudar o código da extensão, rode `npm run build` de novo e clique em
**Recarregar** na página de extensões.

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

Configurações e lista de downloads ficam em `%APPDATA%\meu-downloader`. A lista guarda
os cabeçalhos de cada download (inclusive cookies enviados pela extensão) para poder
retomá-lo.
Para um perfil separado (por exemplo, uma cópia portátil), defina a variável
`MD_USER_DATA` com outra pasta antes de iniciar.

## Testes

```bash
npm test
```

O comando compila o projeto e roda os testes já compilados (`dist/test/*.test.js`).

Os testes sobem servidores HTTP locais e não acessam a internet nem serviços de
streaming. Eles cobrem:

- **Arquivos:** segmentação e paralelismo, pausa e retomada a partir do estado salvo,
  servidor sem `Range`, tamanho desconhecido, redirecionamento com `Content-Disposition`,
  conexões que caem, erros HTTP, recusa de páginas web, limite de velocidade, fila do
  gerenciador e a segurança da ponte com a extensão.
- **Manifestos (`test/manifest.test.ts`):** HLS principal e de mídia, URLs relativas,
  intervalos de bytes, AES-128, DASH com template, timeline, lista e `BaseURL`, áudio
  e legendas, seleção de qualidade, recusa de DRM, ao vivo e estruturas não suportadas,
  parser XML e detecção de endereços internos.
- **Streams (`test/stream.test.ts`):** ordem dos segmentos, escolha de variante,
  intervalos de bytes, fMP4, descriptografia AES-128, novas tentativas após HTTP 503,
  erro 404 e retomada, pausa e retomada do estado salvo, manifesto alterado durante a
  pausa, recusa de DRM (inclusive no MP4) e de ao vivo, cookies restritos ao host,
  bloqueio de rede interna, legendas, DASH só áudio, cancelamento, restauração após
  fechar o app e conversão automática no gerenciador.
- **Com o FFmpeg real:** gera HLS (TS e fMP4) e DASH sintéticos e confere com o ffprobe
  que o MP4/M4A final tem as faixas certas. Também testa a falha do FFmpeg.
- **Com o yt-dlp real:** download de vídeo, pausa/retomada, conversão de página com
  player e as fontes de cookies.

Os testes que precisam de `bin/ffmpeg` ou `bin/yt-dlp` são ignorados (skip) se eles
não estiverem lá.

## Limitações

- Não há botão "baixar vídeo" desenhado sobre os players; use o menu do botão direito
  ou cole o link.
- Vídeos que exigem login só funcionam com uma fonte de cookies configurada (veja
  **Vídeos**). Chrome e Edge não podem ser lidos direto; use a extensão ou um `cookies.txt`.
- Conteúdo com DRM (Netflix, Spotify, Disney+ etc.) não pode ser baixado, por decisão
  de projeto.
- Streams: só VOD (sem ao vivo); DASH com um único período; somente o áudio padrão é
  baixado (não há escolha de idioma); legendas apenas WebVTT. O tempo das legendas
  segue os arquivos WebVTT (o `X-TIMESTAMP-MAP` não é reaplicado). Representações DASH
  de arquivo único usam uma conexão só.
- A extensão não detecta sozinha os `.m3u8`/`.mpd` que uma página carrega. Copie o link
  do manifesto (ferramentas do desenvolvedor → Rede) ou use o menu do botão direito em
  um `<video>` cujo endereço seja o manifesto.
- Downloads iniciados por formulário (POST) não são reproduzidos pelo app. A
  extensão não consegue repetir o corpo do pedido, então eles continuam no navegador.
- Não há suporte a FTP.
