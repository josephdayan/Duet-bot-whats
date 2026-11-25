# WhatsApp → Gmail (Twilio + Vercel)

Você encaminha uma mensagem do WhatsApp para o número do bot. O Twilio chama este webhook, que baixa as mídias e manda tudo por e-mail para o seu Gmail com o assunto começando por **[WA fwd]**. O Claude lê de lá (busca `subject:"[WA fwd]"`).

O código está pronto e testado (16 testes, `npm test`). Falta só a parte que depende das suas contas.

## Como funciona

- **Texto:** vira o corpo do e-mail; o assunto traz uma prévia.
- **Imagem, PDF, Word, Excel, vídeo, contato:** viram anexos (até 20 MB por mensagem, por causa do limite do Gmail).
- **Áudio:** chega como anexo `.ogg`. O Claude não escuta áudio, então fica arquivado mas não lido. Transcrição dá para acrescentar depois, se quiser.
- **Localização:** vira link do Google Maps.
- **Segurança:** só aceita chamadas assinadas pelo seu Twilio e só encaminha mensagens dos números em `ALLOWED_FROM`. Qualquer outro remetente é ignorado.

Dois limites do próprio WhatsApp:
- Uma mensagem encaminhada **não traz o autor original**. O e-mail marca "encaminhada", mas quem escreveu você precisa dizer (ou mandar um texto junto).
- Encaminhar 5 mensagens de uma vez gera 5 e-mails.

## O que só você pode fazer

### 1. Colocar o código no Vercel
O conector do Vercel aqui não tem permissão para criar projeto, então esse passo é seu. Duas opções:
- **GitHub (recomendado):** crie um repositório **privado e vazio** chamado `whatsapp-forward` e me avise; eu subo o código. Depois, no Vercel: **Add New → Project → Import** esse repositório → **Deploy** (sem mudar nada).
- **Pelo seu computador:** baixe esta pasta e rode `npx vercel deploy --prod` dentro dela.

O endereço do webhook vai ser `https://<nome-do-projeto>.vercel.app/api/whatsapp`. Abrir esse endereço no navegador deve mostrar `whatsapp-forward ok`.

### 2. Senha de app do Gmail
1. A conta precisa ter verificação em duas etapas ligada.
2. Em myaccount.google.com/apppasswords, crie uma senha de app chamada "whatsapp-forward".
3. Guarde os 16 caracteres para o passo 4. Não mande essa senha no chat.

Por que Gmail com senha de app: é a opção com menos configuração. Não precisa de conta nova nem de domínio; o próprio Gmail manda o e-mail para ele mesmo. (Resend ou SendGrid exigiriam conta nova e, para uso sério, verificar um domínio.)

### 3. Twilio
**Para começar (sandbox, de graça no trial):**
1. Crie a conta no Twilio. O trial vem com crédito para testes.
2. Console → **Messaging → Try it out → Send a WhatsApp message**. Mande do seu WhatsApp a mensagem `join <código>` para o número do sandbox (+1 415 523 8886).
3. Em **Sandbox settings**, no campo **When a message comes in**, cole a URL do passo 1, método **POST**, e salve.
4. Na página inicial do Console, copie **Account SID** e **Auth Token** para o passo 4.

### 4. Variáveis de ambiente no Vercel
Projeto → **Settings → Environment Variables** (ambiente Production):

| Nome | Valor |
|---|---|
| `TWILIO_ACCOUNT_SID` | Account SID (começa com AC) |
| `TWILIO_AUTH_TOKEN` | Auth Token |
| `GMAIL_USER` | o seu endereço do Gmail |
| `GMAIL_APP_PASSWORD` | a senha de app do passo 2 |
| `ALLOWED_FROM` | seu número, ex.: `whatsapp:+5511999999999` (vários separados por vírgula) |
| `MAIL_TO` | opcional; padrão é o próprio `GMAIL_USER` |
| `REPLY_ACK` | opcional; `1` faz o bot responder "✓ no e-mail" (custa US$0,005 por resposta) |

Depois de salvar, vá em **Deployments → ⋯ → Redeploy**, porque as variáveis só valem num deploy novo.

### 5. Testar
Mande "teste" para o número do sandbox. Em alguns segundos deve chegar no Gmail um e-mail "[WA fwd] teste". Se não chegar, veja **Monitor → Logs → Errors** no Twilio e **Logs** no Vercel. Um 403 com "invalid signature" quase sempre é a URL no Twilio diferente da URL real (com ou sem barra no fim, outro domínio); nesse caso, coloque a URL exata em `PUBLIC_URL`.

## Sandbox x número próprio

| | Sandbox | Número próprio (produção) |
|---|---|---|
| Custo | grátis no trial | US$0,005 por mensagem recebida + o número |
| Validade | precisa mandar `join` de novo a cada 3 dias | permanente |
| Número | compartilhado, com logo do Twilio | seu, com o nome que você escolher |
| Respostas para o Brasil | podem ser bloqueadas pelo Twilio (só afeta o `REPLY_ACK`) | normais |
| Exige | nada | conta Twilio paga, um número (um do Twilio, por volta de US$1–2/mês, ou um chip seu que não esteja no WhatsApp) e uma conta Meta Business, pelo cadastro de WhatsApp Sender no Twilio |

Custo realista em produção: as mensagens que você manda para o bot são conversas de serviço, que a Meta não cobra. O Twilio cobra US$0,005 por mensagem. Com 300 encaminhamentos por mês dá cerca de US$1,50, mais o número. O Vercel no plano Hobby é grátis para esse volume.

Recomendação: comece pelo sandbox para ver se o hábito pega. Se pegar, a troca é só registrar o número próprio e colar a mesma URL no campo de webhook dele.

## Arquivos
- `api/whatsapp.js`: a função do Vercel (envio pelo Gmail via SMTP).
- `lib/core.js`: assinatura do Twilio, leitura da mensagem, download das mídias e montagem do e-mail.
- `test/core.test.js`: testes (`npm install && npm test`); a assinatura é conferida contra a biblioteca oficial do Twilio.
