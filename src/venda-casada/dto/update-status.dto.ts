import { ApiProperty } from '@nestjs/swagger';
import { IsDefined, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateStatusDto {
  @ApiProperty({ description: 'Novo status da encomenda', example: 'Cancelado' })
  @IsDefined()
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  status!: string;

  @ApiProperty({
    description:
      'Motivo do cancelamento (grava em `motivoCancelamento`). Obrigatório quando o status é "Cancelado".',
    required: false,
    example: 'Cliente desistiu da compra',
  })
  @IsOptional()
  @IsString()
  motivo?: string;

  @ApiProperty({
    description:
      'Motivo de não cotar a encomenda (grava em `motivoDenaoCotar`). Opcional: se não vier, ' +
      'o valor atual é mantido; se vier vazio, é limpo.',
    required: false,
    example: 'Peça fora de linha',
  })
  @IsOptional()
  @IsString()
  motivoDenaoCotar?: string;

  @ApiProperty({
    description:
      'Prazo da encomenda (grava em `prazo`, coluna DATE) no formato YYYY-MM-DD. Opcional: se não ' +
      'vier, o valor atual é mantido; se vier vazio ou null, é limpo.',
    required: false,
    nullable: true,
    example: '2026-09-30',
  })
  @IsOptional()
  @IsString()
  prazo?: string | null;
}
