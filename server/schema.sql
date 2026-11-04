-- Schéma MySQL / MariaDB du parc d'imprimantes AUBM.
-- Encodage utf8mb4. Les pourcentages vides restent NULL.

CREATE TABLE IF NOT EXISTS imprimantes (
    id VARCHAR(40) NOT NULL,
    nom VARCHAR(160) NOT NULL,
    departement VARCHAR(80) NOT NULL,
    emplacement VARCHAR(160) NOT NULL,
    adresse VARCHAR(80) NOT NULL,
    couleur TINYINT(1) NOT NULL DEFAULT 0,
    fourniture VARCHAR(80) NOT NULL DEFAULT '',
    releve TEXT NOT NULL,
    observation TEXT NOT NULL,
    ecart TINYINT(1) NOT NULL DEFAULT 0,
    snmp_communaute VARCHAR(64) NOT NULL DEFAULT 'public',
    niveaux_le VARCHAR(40) NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS toners (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    imprimante_id VARCHAR(40) NOT NULL,
    cle VARCHAR(40) NOT NULL,
    libelle VARCHAR(80) NOT NULL,
    pourcentage TINYINT UNSIGNED NULL,
    swatch VARCHAR(20) NULL,
    extra TINYINT(1) NOT NULL DEFAULT 0,
    ordre SMALLINT NOT NULL DEFAULT 0,
    PRIMARY KEY (id),
    UNIQUE KEY uniq_toner (imprimante_id, cle),
    CONSTRAINT fk_toner_imprimante FOREIGN KEY (imprimante_id)
        REFERENCES imprimantes (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS kits (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    imprimante_id VARCHAR(40) NOT NULL,
    libelle VARCHAR(160) NOT NULL,
    pourcentage TINYINT UNSIGNED NULL,
    ordre SMALLINT NOT NULL DEFAULT 0,
    PRIMARY KEY (id),
    KEY idx_kit_imprimante (imprimante_id, ordre),
    CONSTRAINT fk_kit_imprimante FOREIGN KEY (imprimante_id)
        REFERENCES imprimantes (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS departements (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    nom VARCHAR(80) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uniq_dept_nom (nom)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS emplacements (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    departement_id INT UNSIGNED NOT NULL,
    nom VARCHAR(160) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uniq_lieu (departement_id, nom),
    CONSTRAINT fk_lieu_dept FOREIGN KEY (departement_id)
        REFERENCES departements (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS utilisateurs (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    identifiant VARCHAR(80) NOT NULL,
    nom VARCHAR(160) NOT NULL,
    mot_de_passe VARCHAR(255) NOT NULL,
    role VARCHAR(20) NOT NULL,
    actif TINYINT(1) NOT NULL DEFAULT 1,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    UNIQUE KEY uniq_identifiant (identifiant)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS journal (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    imprimante_id VARCHAR(40) NULL,
    imprimante_nom VARCHAR(160) NOT NULL DEFAULT '',
    type VARCHAR(40) NOT NULL,
    type_label VARCHAR(160) NOT NULL,
    detail TEXT NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    KEY idx_journal_imp (imprimante_id),
    KEY idx_journal_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
