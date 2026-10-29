import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { WhatsappService } from './whatsapp.service';

/**
 * Rotas do sensor WhatsApp (piloto WAHA). Nas rotas de contatos com papel
 * (vincular, consultar, apagar, divergências, varredura) quem age vem do
 * `x-user-id` que o proxy da intranet injeta a partir da sessão; o
 * `usuario_id` do body/query é descartado. O webhook aceita o token compartilhado
 * em `x-webhook-token` quando WA_WEBHOOK_TOKEN está definido — configure o mesmo
 * valor nos customHeaders do webhook no WAHA. Sem a variável, o endpoint aceita
 * qualquer chamada (rede interna) — defina o token antes de generalizar.
 */
@Controller('whatsapp')
export class WhatsappController {
  constructor(private readonly service: WhatsappService) {}

  @Post('webhook')
  webhook(@Body() body: any, @Headers('x-webhook-token') token?: string) {
    const esperado = process.env.WA_WEBHOOK_TOKEN;
    if (esperado && token !== esperado) {
      throw new UnauthorizedException('Token do webhook inválido.');
    }
    return this.service.processarWebhook(body ?? {});
  }

  // Semente do vínculo telefone->cliente a partir do cadastro do ERP (idempotente).
  @Post('contatos/seed')
  seed() {
    return this.service.seedContatos();
  }

  // Fila de vínculo: números que conversaram e ainda não têm cliente.
  @Get('contatos/pendentes')
  pendentes(@Query('limite') limite?: string) {
    const n = Number(limite);
    return this.service.pendentes(Number.isFinite(n) && n > 0 ? n : undefined);
  }

  // Lista de vínculo com sugestão: números sem cliente por volume, cada um com
  // o cliente provável e a evidência (orçamento + produto citado, entrega, agenda).
  @Get('contatos/sugestoes')
  sugestoes(@Query('limite') limite?: string, @Query('dias') dias?: string) {
    const l = Number(limite);
    const d = Number(dias);
    return this.service.sugestoesVinculo(
      Number.isInteger(l) && l > 0 && l <= 200 ? l : 50,
      Number.isInteger(d) && d > 0 && d <= 120 ? d : 30,
    );
  }

  // "Não é cliente" (colega, transportadora, fornecedor): sai da lista de vínculo.
  @Post('contatos/ignorar')
  ignorar(@Body() dto: { telefone: string; motivo?: string; usuario_nome?: string }) {
    return this.service.ignorar(dto ?? ({} as any));
  }

  // 1 toque que aprende para sempre (corrige o histórico da chave junto).
  @Post('contatos/vincular')
  vincular(
    @Body()
    dto: {
      telefone: string;
      cli_codigo: number;
      cli_nome?: string;
      usuario_nome?: string;
      contato_nome?: string;
    },
    @Headers('x-user-id') usuario?: string,
  ) {
    return this.service.vincular({ ...dto, usuario_id: usuario });
  }

  // Agenda do celular apontando outro cliente para número já vinculado (só gestão).
  @Get('contatos/divergencias')
  async divergencias(@Headers('x-user-id') usuario?: string) {
    await this.service.exigirPapel(usuario, { gestao: true });
    return this.service.divergencias();
  }

  // Gestão decide a divergência: 'manter' o vínculo ou trocar para o da 'agenda'.
  @Post('contatos/divergencias/:chave/resolver')
  resolverDivergencia(
    @Param('chave') chave: string,
    @Body() dto: { acao: string },
    @Headers('x-user-id') usuario?: string,
  ) {
    return this.service.resolverDivergencia(chave, dto?.acao, usuario);
  }

  // Lê agora a agenda das sessões rep-* (a carga diária também roda). Só gestão.
  @Post('contatos/varrer-agendas')
  async varrerAgendas(@Headers('x-user-id') usuario?: string) {
    await this.service.exigirPapel(usuario, { gestao: true });
    return this.service.varrerAgendas();
  }

  // Números do cliente (ERP, manual e agenda) com o nome da pessoa: gestão vê
  // todos; o vendedor, só os de cliente da própria carteira.
  @Get('contatos/cliente/:cli')
  async contatosDoCliente(@Param('cli', ParseIntPipe) cli: number, @Headers('x-user-id') usuario?: string) {
    await this.service.exigirPapel(usuario, { cli });
    return this.service.contatosDoCliente(cli);
  }

  // Apaga um vínculo (só gestão; número do ERP não se apaga por aqui).
  @Delete('contatos/:chave')
  removerContato(@Param('chave') chave: string, @Headers('x-user-id') usuario?: string) {
    return this.service.removerContato(chave, usuario);
  }

  // As medições que o piloto valida: taxa de casamento e atividade por sessão
  // (+ conteúdo: mensagens com corpo/mídia e áudios por status de transcrição).
  @Get('medicoes')
  medicoes() {
    return this.service.medicoes();
  }

  // Importa as conversas de uma sessão desde uma data (padrão 01/09/2026),
  // em segundo plano. Só sessões em WA_CORPO_SESSOES; repetir não duplica.
  @Post('historico')
  historico(@Body() dto: { sessao: string; desde?: string; so_enviadas?: boolean }) {
    return this.service.importarHistorico(dto?.sessao ?? '', dto?.desde, dto?.so_enviadas === true);
  }

  @Get('historico')
  historicoStatus() {
    return this.service.statusHistorico();
  }

  // Dispara o processador da fila de áudios fora do cron (teste/apuro manual).
  @Post('transcricao/processar')
  processarTranscricao() {
    return this.service.processarAudiosPendentes();
  }

  // A conversa em pauta da sessão do vendedor — o cabeçalho da estação segue
  // o WhatsApp por aqui (polling leve; nulo sem sensor/mensagens).
  @Get('conversa-ativa')
  conversaAtiva(@Query('rep') rep?: string) {
    const n = Number(rep);
    if (!Number.isInteger(n)) return null;
    return this.service.conversaAtiva(n);
  }

  // Número (ou dígitos de LID) -> cliente vinculado — o caminho de volta da
  // estação quando o vendedor clica numa conversa dentro do WhatsApp.
  @Get('resolver-contato')
  resolverContato(@Query('numero') numero?: string) {
    return this.service.resolverContato(numero ?? '');
  }
}
