// metrics.interceptor.ts
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import { Histogram } from 'prom-client';
import { FastifyReply, FastifyRequest } from 'fastify';
import { Observable, tap } from 'rxjs';

/**
 * No Fastify não existe `req.route.path`. O template da rota (ex.: `/venda-casada/:id`)
 * vem de `req.routeOptions.url`, com fallback para `req.routerPath` (Fastify < 4.10).
 * Sem isso o label cairia em `req.url`, que inclui a querystring e explodiria a
 * cardinalidade da métrica no Prometheus.
 */
function routeLabel(req: FastifyRequest): string {
  return (req as any).routeOptions?.url ?? (req as any).routerPath ?? req.url;
}

@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(
    @InjectMetric('http_request_duration_seconds')
    private histogram: Histogram<string>,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const end = this.histogram.startTimer();

    return next.handle().pipe(
      tap({
        next: () => {
          const res = context.switchToHttp().getResponse<FastifyReply>();
          end({
            method: req.method,
            route: routeLabel(req),
            status_code: res.statusCode,
          });
        },
        error: () => {
          end({ method: req.method, route: routeLabel(req), status_code: 500 });
        },
      }),
    );
  }
}
