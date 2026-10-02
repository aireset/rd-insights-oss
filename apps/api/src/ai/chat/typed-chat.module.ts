import { Module } from '@nestjs/common';
import { LeadsModule } from '../../leads/leads.module';
import { TypedChatController } from './typed-chat.controller';
import { TypedChatService } from './typed-chat.service';

@Module({ imports: [LeadsModule], controllers: [TypedChatController], providers: [TypedChatService] })
export class TypedChatModule {}
