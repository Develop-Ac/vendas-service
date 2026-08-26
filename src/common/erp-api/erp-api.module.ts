import { Global, Module } from '@nestjs/common';
import { ErpApiService } from './erp-api.service';

@Global()
@Module({
  providers: [ErpApiService],
  exports: [ErpApiService],
})
export class ErpApiModule {}
