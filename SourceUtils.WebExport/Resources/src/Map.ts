﻿/// <reference path="../js/facepunch.webgame.d.ts"/>

namespace SourceUtils {
    import WebGame = Facepunch.WebGame;

    export interface IPageInfo {
        first: number;
        count: number;
        url: string;
    }

    export interface IMap {
        name: string;
        lightmapUrl: string;
        visPages: IPageInfo[];
        leafPages: IPageInfo[];
        dispPages: IPageInfo[];
        materialPages: IPageInfo[];
        brushModelPages: IPageInfo[];
        studioModelPages: IPageInfo[];
        vertLightingPages: IPageInfo[];
        entities: Entities.IEntity[];
    }

    export class Map implements WebGame.ICommandBufferParameterProvider {
        static readonly lightmapParam = new WebGame.CommandBufferParameter(WebGame.UniformType.Texture);

        readonly viewer: MapViewer;

        skyCamera: Entities.SkyCamera;

        private tSpawns: Entities.IEntity[];
        private ctSpawns: Entities.IEntity[];
        private playerSpawns: Entities.IEntity[];

        private worldspawn: Entities.Worldspawn;
        private pvsEntities: Entities.PvsEntity[];

        private lightmap: WebGame.TextureLoadable;
        private skyCube: SkyCube;

        private info: IMap;
        private clusterVis: { [cluster: number]: number[] } = {};
        private clusterEnts: { [cluster: number]: Entities.PvsEntity[] } = {};

        constructor(viewer: MapViewer) {
            this.viewer = viewer;
        }

        unload(): void {
            throw new Error("Map unloading not implemented.");
        }

        load(url: string): void {
            Facepunch.Http.getJson<IMap>(url, info => {
                this.onLoad(info);
            });
        }

        getLightmapLoadProgress(): number {
            return this.lightmap == null ? 0 : this.lightmap.getLoadProgress();
        }

        private onLoad(info: IMap): void {
            if (this.info != null) this.unload();

            this.info = info;
            this.viewer.visLoader.setPageLayout(info.visPages);
            this.viewer.leafGeometryLoader.setPageLayout(info.leafPages);
            this.viewer.dispGeometryLoader.setPageLayout(info.dispPages);
            this.viewer.mapMaterialLoader.setPageLayout(info.materialPages);
            this.viewer.bspModelLoader.setPageLayout(info.brushModelPages);
            this.viewer.studioModelLoader.setPageLayout(info.studioModelPages);
            this.viewer.vertLightingLoader.setPageLayout(info.vertLightingPages);

            this.lightmap = this.viewer.textureLoader.load(info.lightmapUrl);

            this.tSpawns = [];
            this.ctSpawns = [];
            this.playerSpawns = [];

            this.pvsEntities = [];
            for (let i = 0, iEnd = info.entities.length; i < iEnd; ++i) {
                const ent = info.entities[i];
                let pvsInst: Entities.PvsEntity = null;

                switch (ent.classname) {
                    case "worldspawn":
                        const worldspawn = ent as Entities.IWorldspawn;
                        this.worldspawn = new Entities.Worldspawn(this, worldspawn);
                        this.lightmap.addUsage(this.worldspawn);

                        if (worldspawn.skyMaterial != null) {
                            const skyMat = new WebGame.MaterialLoadable(this.viewer);
                            skyMat.loadFromInfo(worldspawn.skyMaterial);
                            this.skyCube = new SkyCube(this.viewer, skyMat);
                        }

                        break;
                    case "env_fog_controller":
                        const fogController = ent as Entities.IEnvFogController;
                        const fog = this.viewer.mainCamera.fog;
                        if (!fogController.fogEnabled) break;
                        fog.color.set(fogController.fogColor.r, fogController.fogColor.g, fogController.fogColor.b);
                        fog.start = fogController.fogStart;
                        fog.end = fogController.fogEnd;
                        fog.maxDensity = fogController.fogMaxDensity;

                        if (fogController.farZ !== 0) this.viewer.mainCamera.setFar(fogController.farZ);
                        break;
                    case "info_player_terrorist":
                        this.tSpawns.push(ent);
                        break;
                    case "info_player_counterterrorist":
                        this.ctSpawns.push(ent);
                        break;
                    case "info_player_start":
                        this.playerSpawns.push(ent);
                        break;
                    case "displacement":
                        pvsInst = new Entities.Displacement(this, ent as Entities.IDisplacement);
                        break;
                    case "func_brush":
                        pvsInst = new Entities.BrushEntity(this, ent as Entities.IBrushEntity);
                        break;
                    case "prop_static":
                        if ((ent as Entities.IStaticProp).model === -1) break;
                        pvsInst = new Entities.StaticProp(this, ent as Entities.IStaticProp);
                        break;
                    case "sky_camera":
                        this.skyCamera = new Entities.SkyCamera(this.viewer, ent as Entities.ISkyCamera);
                        break;
                }

                if (pvsInst != null) {
                    this.pvsEntities.push(pvsInst);
                }
            }

            const spawn = this.tSpawns[0] || this.ctSpawns[0] || this.playerSpawns[0];
            this.viewer.mainCamera.setPosition(spawn.origin);
            this.viewer.mainCamera.translate(0, 0, 64);
            this.viewer.setCameraAngles((spawn.angles.y - 90) * Math.PI / 180, spawn.angles.x * Math.PI / 180);

            this.viewer.forceDrawListInvalidation(true);
        }

        getPvsEntitiesInCluster(cluster: number): Entities.PvsEntity[] {
            let ents = this.clusterEnts[cluster];
            if (ents !== undefined) return ents;

            this.clusterEnts[cluster] = ents = [];

            for (let ent of this.pvsEntities) {
                if (ent.isInCluster(cluster)) {
                    ents.push(ent);
                }
            }

            return ents;
        }

        getLeafAt(pos: Facepunch.IVector3): BspLeaf {
            if (this.worldspawn == null || this.worldspawn.model == null) return undefined;
            return this.worldspawn.model.getLeafAt(pos);
        }

        populateDrawList(drawList: WebGame.DrawList, pvsRoot: BspLeaf): void {
            if (this.worldspawn == null) return;

            if (pvsRoot != null && this.skyCube != null && (this.skyCamera == null || pvsRoot === this.skyCamera.getLeaf())) {
                drawList.addItem(this.skyCube);
            }

            let vis: number[] = null;

            if (this.worldspawn.model != null && pvsRoot != null && pvsRoot.cluster !== undefined) {
                const cluster = pvsRoot.cluster;

                vis = this.clusterVis[cluster];
                if (vis === undefined) {
                    let immediate = true;
                    this.viewer.visLoader.load(cluster,
                        loaded => {
                            this.clusterVis[cluster] = vis = loaded;
                            if (!immediate) this.viewer.forceDrawListInvalidation(true);
                        });
                    immediate = false;

                    if (vis === undefined) {
                        this.clusterVis[cluster] = vis = null;
                    }
                }
            }

            this.worldspawn.populateDrawList(drawList, vis);

            if (vis == null) {
                for (let ent of this.pvsEntities) {
                    drawList.addItem(ent);
                }
                return;
            }

            for (let cluster of vis) {
                const ents = this.getPvsEntitiesInCluster(cluster);
                for (let ent of ents) {
                    if (ent.getIsInDrawList(drawList)) continue;
                    drawList.addItem(ent);
                }
            }
        }

        populateCommandBufferParameters(buf: Facepunch.WebGame.CommandBuffer): void {
            const lightmap = this.lightmap != null && this.lightmap.isLoaded()
                ? this.lightmap
                : WebGame.TextureUtils.getWhiteTexture(this.viewer.context);

            buf.setParameter(Map.lightmapParam, lightmap);
        }
    }
}