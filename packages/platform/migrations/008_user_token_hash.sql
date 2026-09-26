-- 008_user_token_hash.sql · desk bearer tokens are stored as SHA-256, never in clear.
-- A leaked row or backup no longer logs anyone in. Existing tokens keep working.
alter table neos.users add column token_hash text unique;
update neos.users set token_hash = encode(sha256(convert_to(dev_token, 'UTF8')), 'hex') where dev_token is not null;
update neos.users set dev_token = null;
