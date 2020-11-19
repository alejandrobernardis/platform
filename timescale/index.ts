import * as pulumi from "@pulumi/pulumi";
import * as ocean from "@pulumi/digitalocean";
import * as k8s from "@pulumi/kubernetes";
import { project, provider } from "../cluster";
import * as crd from "../crd";

const cf = new pulumi.Config("m3o");
const conf = new pulumi.Config("digitalocean");

export const namespace = new k8s.core.v1.Namespace(
  "timescale",
  { metadata: { name: "timescale" } },
  { provider }
);

export const tls = new crd.certmanager.v1.Certificate(
  "timescale-tls",
  {
    metadata: {
      name: "timescale-tls",
      namespace: namespace.metadata.name
    },
    spec: {
      secretName: "timescale-tls",
      subject: {
        organizations: ["m3o"]
      },
      isCA: false,
      privateKey: {
        algorithm: "ECDSA",
        size: 256
      },
      dnsNames: ["timescale.timescale.svc.cluster.local", "timescale"],
      issuerRef: {
        name: "ca",
        kind: "ClusterIssuer"
      }
    }
  },
  { provider }
);

export const bucket = new ocean.SpacesBucket("timescale-backups", {
  region: "ams3",
}, {
  parent: project,
});

export const creds = new k8s.core.v1.Secret(
  "timescale-credentials",
  {
    metadata: {
      namespace: namespace.metadata.name
    },
    stringData: {
      PATRONI_SUPERUSER_PASSWORD: cf.require("patroni_superuser_password"),
      PATRONI_REPLICATION_PASSWORD: cf.require("patroni_replication_password"),
      PATRONI_admin_PASSWORD: cf.require("patroni_admin_password")
    }
  },
  { provider }
);

export const pgBackrest = new k8s.core.v1.Secret(
  "timescale-pgbackrest",
  {
    metadata: {
      namespace: namespace.metadata.name,
    },
    stringData: {
      PGBACKREST_REPO1_S3_BUCKET: bucket.name,
      PGBACKREST_REPO1_S3_REGION: bucket.region as any,
      PGBACKREST_REPO1_S3_KEY: conf.require("spacesAccessId"),
      PGBACKREST_REPO1_S3_KEY_SECRET: conf.require("spacesSecretKey"),
      PGBACKREST_REPO1_S3_ENDPOINT: "ams3.digitaloceanspaces.com",
    }
  },
  { provider }
);

export const chart = new k8s.helm.v3.Chart(
  "timescale",
  {
    namespace: namespace.metadata.name,
    chart: "timescaledb-single",
    fetchOpts: { repo: "https://charts.timescale.com" },
    values: {
      image: { tag: "pg12.4-ts1.7.4-p1" },
      replicaCount: 2,
      loadBalancer: {
        enabled: false
      },
      prometheus: { enabled: true },
      rbac: {
        enabled: true
      },
      secretNames: {
        credentials: creds.metadata.name,
        certificate: tls.spec.secretName,
        pgbackrest: pgBackrest.metadata.name,
      },
      backup: {
        enabled: true,
        envFrom: [
          {
            secretRef: {
              name: pgBackrest.metadata.name
            }
          }
        ]
      },
      persistentVolumes: {
        data: {
          enabled: true,
          size: "40Gi",
        },
        wal: {
          enabled: true,
          size: "5Gi",
        }
      },
      patroni: {
        postgresql: { parameters: { max_wal_size: "4GB" } }
      }
    }
  },
  { provider }
);

export default [namespace, tls, bucket, creds, pgBackrest];
