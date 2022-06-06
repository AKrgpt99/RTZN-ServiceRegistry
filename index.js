const { EventEmitter } = require("events");
const axios = require("axios").default;
const redis = require("redis");

class ServiceRegistry extends EventEmitter {
  constructor() {
    if (ServiceRegistry._instance) return ServiceRegistry._instance;
    super();
    ServiceRegistry._instance = this;
    this._services = {};
  }

  static instance() {
    if (!ServiceRegistry._instance) {
      return new ServiceRegistry();
    }
    return ServiceRegistry._instance;
  }

  static endpointExists(service, endpoint) {
    for (let serviceEndpoint of service.endpoints.public) {
      if (serviceEndpoint.contains(endpoint)) return true;
    }
    for (let serviceEndpoint of service.endpoints.protected) {
      if (serviceEndpoint.contains(endpoint)) return true;
    }
    return false;
  }

  static endpointProtected(service, endpoint) {
    for (let protectedEndpoint of service.endpoints.protected) {
      if (protectedEndpoint.contains(endpoint)) return true;
    }
    return false;
  }

  static endpointInternal(service, endpoint) {
    for (let internalEndpoint of service.endpoints.internal) {
      if (internalEndpoint.contains(endpoint)) return true;
    }
    return false;
  }

  async addService(name, hosts, endpoints) {
    return new Promise((resolve) => {
      if (!this._services[name]) {
        this._services[name] = { hosts, endpoints };
        this.emit("service-connected", name);
      }

      resolve(this._services[name]);
    });
  }

  service(name) {
    return this._services[name];
  }

  serviceName(host) {
    return Object.keys(this._services).reduce((_, serviceKey) => {
      return this._services[serviceKey].hosts.reduce((_, serviceHost) => {
        if (host === serviceHost) {
          return serviceKey;
        }
      });
    });
  }

  services() {
    return this._services;
  }

  async removeService(name) {
    if (!this._services[name]) return;

    delete this._services[name];
    this.emit("service-disconnected", name);

    return new Promise((resolve) => {
      resolve(this._services[name]);
    });
  }

  async heartbeat(serviceName) {
    axios
      .get(`http://${this.service(serviceName).hosts[0]}/hb`)
      .then(function () {
        console.log(`[service-manager] ${serviceName} OK`);
      })
      .catch(function (err) {
        throw err;
      });
  }

  async initRedis(redisURL) {
    try {
      const redisClient = redis.createClient({ url: redisURL });
      await redisClient.connect();

      const allHosts = await redisClient.scan(0, { MATCH: "registry_*_hosts" });
      for (serviceKey of allHosts.keys) {
        const serviceName = serviceKey.split("_")[1];

        const hosts = JSON.parse(
          await redisClient.get(`registry_${serviceName}_hosts`)
        );

        const endpoints = JSON.parse(
          await redisClient.get(`registry_${serviceName}_endpoints`)
        );

        await this.addService(
          serviceName,
          typeof hosts === "string" ? JSON.parse(hosts) : hosts,
          typeof endpoints === "string" ? JSON.parse(endpoints) : endpoints
        );

        await this.heartbeat(serviceName);
      }

      this.on("service-connected", async function (name) {
        await redisClient.set(
          `registry_${name}_endpoints`,
          JSON.stringify(this.service(name).endpoints)
        );
        await redisClient.set(
          `registry_${name}_hosts`,
          JSON.stringify(this.service(name).hosts)
        );
        console.log(`[service-manager] connected to ${name}`);
      });

      this.on("service-disconnected", async function (name) {
        await redisClient.del(`registry_${name}_endpoints`);
        await redisClient.del(`registry_${name}_hosts`);
        console.log(`[service-manager] disconnected from ${name}`);
      });
    } catch (err) {
      throw err;
    }
  }
}

module.exports = ServiceRegistry.instance;
