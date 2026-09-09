UPDATE "sav"."messages"
SET "preview" = regexp_replace("preview", '[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}', '[email masqué]', 'gi')
WHERE "preview" ~* '[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}';
