CREATE DATABASE IF NOT EXISTS paychain CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE USER IF NOT EXISTS 'paychain'@'localhost' IDENTIFIED BY 'paychain_password';
CREATE USER IF NOT EXISTS 'paychain'@'127.0.0.1' IDENTIFIED BY 'paychain_password';
CREATE USER IF NOT EXISTS 'paychain'@'%' IDENTIFIED BY 'paychain_password';

GRANT ALL PRIVILEGES ON paychain.* TO 'paychain'@'localhost';
GRANT ALL PRIVILEGES ON paychain.* TO 'paychain'@'127.0.0.1';
GRANT ALL PRIVILEGES ON paychain.* TO 'paychain'@'%';

FLUSH PRIVILEGES;
