CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX "Lead_name_trgm_idx" ON "Lead" USING GIN ("name" gin_trgm_ops);
CREATE INDEX "Lead_email_trgm_idx" ON "Lead" USING GIN ("email" gin_trgm_ops);
CREATE INDEX "Lead_phone_trgm_idx" ON "Lead" USING GIN ("phone" gin_trgm_ops);
CREATE INDEX "Lead_company_trgm_idx" ON "Lead" USING GIN ("company" gin_trgm_ops);
