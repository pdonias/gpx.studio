import { distance, type Coordinates, type GPXFile, type TrackSegment, TrackPoint } from "gpx";
import { get, type Writable } from "svelte/store";
import { computeAnchorPoints, type SimplifiedTrackPoint } from "./Simplify";
import mapboxgl from "mapbox-gl";
import { route } from "./Routing";
import { applyToFileElement, applyToFileStore } from "$lib/stores";

export class RoutingControls {
    map: mapboxgl.Map;
    file: Writable<GPXFile>;
    markers: mapboxgl.Marker[] = [];
    popup: mapboxgl.Popup;
    popupElement: HTMLElement;
    unsubscribe: () => void = () => { };

    toggleMarkersForZoomLevelAndBoundsBinded: () => void = this.toggleMarkersForZoomLevelAndBounds.bind(this);
    extendFileBinded: (e: mapboxgl.MapMouseEvent) => void = this.extendFile.bind(this);

    constructor(map: mapboxgl.Map, file: Writable<GPXFile>, popup: mapboxgl.Popup, popupElement: HTMLElement) {
        this.map = map;
        this.file = file;
        this.popup = popup;
        this.popupElement = popupElement;

        this.add();
    }

    add() {
        this.map.on('zoom', this.toggleMarkersForZoomLevelAndBoundsBinded);
        this.map.on('move', this.toggleMarkersForZoomLevelAndBoundsBinded);
        this.map.on('click', this.extendFileBinded);

        this.unsubscribe = this.file.subscribe(this.updateControls.bind(this));
    }

    updateControls() {
        // Update controls
        for (let segment of get(this.file).getSegments()) {
            if (!segment._data.anchors) { // New segment
                computeAnchorPoints(segment);
                this.createMarkers(segment);
                continue;
            }

            let anchors = segment._data.anchors;
            for (let i = 0; i < anchors.length;) {
                let anchor = anchors[i];
                if (anchor.point._data.index >= segment.trkpt.length || anchor.point !== segment.trkpt[anchor.point._data.index]) { // Point removed
                    anchors.splice(i, 1);
                    this.markers[i].remove();
                    this.markers.splice(i, 1);
                    continue;
                }
                i++;
            }
        }

        this.toggleMarkersForZoomLevelAndBounds();
    }

    remove() {
        for (let marker of this.markers) {
            marker.remove();
        }
        this.map.off('zoom', this.toggleMarkersForZoomLevelAndBoundsBinded);
        this.map.off('move', this.toggleMarkersForZoomLevelAndBoundsBinded);
        this.map.off('click', this.extendFileBinded);

        this.unsubscribe();
    }

    createMarkers(segment: TrackSegment) {
        for (let anchor of segment._data.anchors) {
            this.createMarker(anchor);
        }
    }

    createMarker(anchor: SimplifiedTrackPoint) {
        let element = document.createElement('div');
        element.className = `h-3 w-3 rounded-full bg-background border-2 border-black cursor-pointer`;

        let marker = new mapboxgl.Marker({
            draggable: true,
            element
        }).setLngLat(anchor.point.getCoordinates());

        Object.defineProperty(marker, '_simplified', {
            value: anchor
        });
        anchor.marker = marker;

        let lastDragEvent = 0;
        marker.on('dragstart', (e) => {
            lastDragEvent = Date.now();
            this.map.getCanvas().style.cursor = 'grabbing';
            element.classList.add('cursor-grabbing');
        });
        marker.on('dragend', () => {
            lastDragEvent = Date.now();
            this.map.getCanvas().style.cursor = '';
            element.classList.remove('cursor-grabbing');
        });
        marker.on('dragend', this.updateAnchor.bind(this));
        marker.getElement().addEventListener('click', (e) => {
            if (Date.now() - lastDragEvent < 100) {
                return;
            }

            marker.setPopup(this.popup);
            marker.togglePopup();
            e.stopPropagation();

            let deleteThisAnchor = this.getDeleteAnchor(anchor);
            this.popupElement.addEventListener('delete', deleteThisAnchor);
            this.popup.once('close', () => {
                this.popupElement.removeEventListener('delete', deleteThisAnchor);
            });
        });

        this.markers.push(marker);
    }

    toggleMarkersForZoomLevelAndBounds() {
        let zoom = this.map.getZoom();
        this.markers.forEach((marker) => {
            Object.defineProperty(marker, '_inZoom', {
                value: marker._simplified.zoom <= zoom,
                writable: true
            });
            if (marker._inZoom && this.map.getBounds().contains(marker.getLngLat())) {
                marker.addTo(this.map);
            } else {
                marker.remove();
            }
        });
    }

    async updateAnchor(e: any) {
        let marker = e.target;
        let anchor = marker._simplified;

        let latlng = marker.getLngLat();
        let coordinates = {
            lat: latlng.lat,
            lon: latlng.lng
        };

        let [previousAnchor, nextAnchor] = this.getNeighbouringAnchors(anchor);

        let anchors = [];
        let targetCoordinates = [];

        if (previousAnchor !== null) {
            anchors.push(previousAnchor);
            targetCoordinates.push(previousAnchor.point.getCoordinates());
        }

        anchors.push(anchor);
        targetCoordinates.push(coordinates);

        if (nextAnchor !== null) {
            anchors.push(nextAnchor);
            targetCoordinates.push(nextAnchor.point.getCoordinates());
        }

        await this.routeBetweenAnchors(anchors, targetCoordinates);
    }

    getDeleteAnchor(anchor: SimplifiedTrackPoint) {
        return () => this.deleteAnchor(anchor);
    }

    async deleteAnchor(anchor: SimplifiedTrackPoint) {
        let [previousAnchor, nextAnchor] = this.getNeighbouringAnchors(anchor);

        if (previousAnchor === null) {
            // remove trackpoints until nextAnchor
        } else if (nextAnchor === null) {
            // remove trackpoints from previousAnchor
        } else {
            // route between previousAnchor and nextAnchor
            this.routeBetweenAnchors([previousAnchor, nextAnchor], [previousAnchor.point.getCoordinates(), nextAnchor.point.getCoordinates()]);
        }
    }

    async extendFile(e: mapboxgl.MapMouseEvent) {
        let segments = get(this.file).getSegments();
        if (segments.length === 0) {
            return;
        }

        let segment = segments[segments.length - 1];
        let anchors = segment._data.anchors;
        let lastAnchor = anchors[anchors.length - 1];

        let newPoint = new TrackPoint({
            attributes: {
                lon: e.lngLat.lng,
                lat: e.lngLat.lat
            }
        });
        newPoint._data.index = segment.trkpt.length - 1; // Do as if the point was the last point in the segment
        newPoint._data.segment = segment;
        let newAnchor = {
            point: newPoint,
            zoom: 0
        };
        this.createMarker(newAnchor);
        segment._data.anchors.push(newAnchor);

        this.routeBetweenAnchors([lastAnchor, newAnchor], [lastAnchor.point.getCoordinates(), newAnchor.point.getCoordinates()]);
    }

    getNeighbouringAnchors(anchor: SimplifiedTrackPoint): [SimplifiedTrackPoint | null, SimplifiedTrackPoint | null] {
        let previousAnchor: SimplifiedTrackPoint | null = null;
        let nextAnchor: SimplifiedTrackPoint | null = null;

        let segment = anchor.point._data.segment;
        let anchors = segment._data.anchors;
        for (let i = 0; i < anchors.length; i++) {
            if (anchors[i].point._data.index < anchor.point._data.index &&
                anchors[i].point._data.segment === anchor.point._data.segment &&
                anchors[i].marker._inZoom) {
                if (!previousAnchor || anchors[i].point._data.index > previousAnchor.point._data.index) {
                    previousAnchor = anchors[i];
                }
            } else if (anchors[i].point._data.index > anchor.point._data.index &&
                anchors[i].point._data.segment === anchor.point._data.segment &&
                anchors[i].marker._inZoom) {
                if (!nextAnchor || anchors[i].point._data.index < nextAnchor.point._data.index) {
                    nextAnchor = anchors[i];
                }
            }
        }

        return [previousAnchor, nextAnchor];
    }

    async routeBetweenAnchors(anchors: SimplifiedTrackPoint[], targetCoordinates: Coordinates[]) {
        if (anchors.length === 1) {
            anchors[0].point.setCoordinates(targetCoordinates[0]);
            return;
        }

        let segment = anchors[0].point._data.segment;

        let response = await route(targetCoordinates);

        let start = anchors[0].point._data.index + 1;
        let end = anchors[anchors.length - 1].point._data.index - 1;

        if (anchors[0].point._data.index === 0) { // First anchor is the first point of the segment
            anchors[0].point = response[0]; // Update the first anchor in case it was not on a road
            start--; // Remove the original first point
        }

        if (anchors[anchors.length - 1].point._data.index === anchors[anchors.length - 1].point._data.segment.trkpt.length - 1) { // Last anchor is the last point of the segment
            anchors[anchors.length - 1].point = response[response.length - 1]; // Update the last anchor in case it was not on a road
            end++; // Remove the original last point
            console.log('end', end);
        }

        for (let i = 1; i < anchors.length - 1; i++) {
            // Find the closest point to the intermediate anchor
            // and transfer the marker to that point
            let minDistance = Number.MAX_VALUE;
            let minIndex = 0;
            for (let j = 1; j < response.length - 1; j++) {
                let dist = distance(response[j].getCoordinates(), targetCoordinates[i]);
                if (dist < minDistance) {
                    minDistance = dist;
                    minIndex = j;
                }
            }
            anchors[i].point = response[minIndex];
        }

        anchors.forEach((anchor) => {
            anchor.zoom = 0; // Make these anchors permanent
            anchor.marker.setLngLat(anchor.point.getCoordinates()); // Update the marker position if needed
        });

        applyToFileElement(this.file, segment, (segment) => {
            segment.replace(start, end, response);
        }, true);
    }
}